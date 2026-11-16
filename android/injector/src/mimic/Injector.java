package mimic;

import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.FileWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * 触摸注入器（Android 10 / API 29 实测）。
 *
 * 为什么不直接用 `adb shell input`：AOSP 的 InputShellCommand 写死了三件事——
 *   DOWN/UP 同一时间戳（按压 0 ms）、pressure/size 恒为 1.0、无中间 MOVE、无 history。
 * 这里用同一套注入机制（app_process + InputManager.injectInputEvent），
 * 但由我们决定按压时长、压力曲线、接触面积、每个 MOVE 的时间戳与轨迹。
 *
 * 改不了的：deviceId 会被 InputDispatcher 强制改写成 VIRTUAL_KEYBOARD_ID(-1)。
 * 这是 AOSP 故意留的口子（防止伪装成真实硬件），不在本工具的解决范围内。
 *
 * 运行（adb shell，uid=shell，具备 INJECT_EVENTS 权限）：
 *   CLASSPATH=/data/local/tmp/mimic-injector.dex app_process /system/bin mimic.Injector 7801
 * 配合：adb forward tcp:7801 tcp:7801
 *
 * 协议：一行一条命令，一行一条回复（`ok ...` / `err ...`）
 *   ping
 *   info
 *   press <pressure> <size>          设默认压力/面积（0..1），影响后续动作
 *   tap <x> <y> <downMs>
 *   hold <x> <y> <ms>                长按（同 tap，只是时长长）
 *   swipe <x1> <y1> <x2> <y2> <ms>
 *   path <x,y,t> <x,y,t> ...         逐点轨迹，t 是相对毫秒；末点后 40ms 抬起
 *   quit
 */
public final class Injector {

    // 默认值来自设备实测与公开数据：真人轻点压力约 0.5、接触面积约 0.12。
    private static float defaultPressure = 0.55f;
    private static float defaultSize = 0.12f;

    private static Object inputManager;
    private static Method injectMethod;
    private static long injected = 0;
    private static long failed = 0;

    public static void main(String[] args) {
        int port = 7801;
        if (args.length >= 1) {
            try {
                port = Integer.parseInt(args[0].trim());
            } catch (NumberFormatException ignored) {
                // 用默认端口
            }
        }

        try {
            setUp();
        } catch (Throwable t) {
            System.out.println("fatal cannot-init " + describe(t));
            System.out.flush();
            return;
        }

        System.out.println("ready uid=" + currentUid() + " port=" + port
                + " manager=" + (inputManager == null ? "null" : inputManager.getClass().getName()));
        System.out.flush();

        ServerSocket server = null;
        for (int attempt = 0; attempt < 10 && server == null; attempt++) {
            try {
                server = new ServerSocket(port, 4, InetAddress.getByName("127.0.0.1"));
            } catch (Throwable bindError) {
                if (attempt == 9) throw new RuntimeException(bindError);
                System.out.println("bind-retry " + attempt + " " + describe(bindError));
                System.out.flush();
                sleepQuietly(300);
            }
        }
        try (ServerSocket bound = server) {
            server.setSoTimeout(0);
            while (true) {
                try (Socket socket = bound.accept()) {
                    socket.setTcpNoDelay(true);
                    BufferedReader in = new BufferedReader(
                            new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                    BufferedWriter out = new BufferedWriter(
                            new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
                    String line;
                    while ((line = in.readLine()) != null) {
                        String reply;
                        boolean quit = false;
                        try {
                            quit = line.trim().equals("quit");
                            reply = quit ? "ok bye" : handle(line.trim());
                        } catch (Throwable t) {
                            reply = "err " + describe(t);
                        }
                        out.write(reply);
                        out.write("\n");
                        out.flush();
                        if (quit) {
                            return;
                        }
                    }
                } catch (Throwable t) {
                    // 单个连接出错不影响继续服务
                    System.out.println("conn-error " + describe(t));
                    System.out.flush();
                }
            }
        } catch (Throwable t) {
            System.out.println("fatal server " + describe(t));
            System.out.flush();
        }
    }

    // ---------------- 注入核心 ----------------

    private static void setUp() throws Exception {
        Object manager = null;
        try {
            Class<?> cls = Class.forName("android.hardware.input.InputManager");
            Method getInstance = cls.getMethod("getInstance");
            getInstance.setAccessible(true);
            manager = getInstance.invoke(null);
        } catch (Throwable ignored) {
            // Android 12+ 换成了 InputManagerGlobal，这台是 10，兜底再试一次
        }
        if (manager == null) {
            Class<?> global = Class.forName("android.hardware.input.InputManagerGlobal");
            Method getInstance = global.getMethod("getInstance");
            getInstance.setAccessible(true);
            manager = getInstance.invoke(null);
        }
        if (manager == null) {
            throw new IllegalStateException("InputManager 拿不到");
        }
        inputManager = manager;

        Class<?> inputEventClass = Class.forName("android.view.InputEvent");
        Method target = null;
        for (Method m : manager.getClass().getMethods()) {
            if (m.getName().equals("injectInputEvent") && m.getParameterCount() == 2) {
                Class<?>[] p = m.getParameterTypes();
                if (p[0].isAssignableFrom(inputEventClass) && p[1] == int.class) {
                    target = m;
                    break;
                }
            }
        }
        if (target == null) {
            throw new IllegalStateException("injectInputEvent 找不到");
        }
        target.setAccessible(true);
        injectMethod = target;
    }

    /** mode 0 = ASYNC：不等 InputDispatcher 处理完，靠真实时间间隔保证顺序。 */
    private static boolean inject(MotionEvent ev) {
        try {
            Object r = injectMethod.invoke(inputManager, ev, 0);
            boolean ok = r instanceof Boolean && (Boolean) r;
            if (ok) {
                injected++;
            } else {
                failed++;
            }
            return ok;
        } catch (Throwable t) {
            failed++;
            throw new IllegalStateException("inject 失败：" + describe(t));
        } finally {
            ev.recycle();
        }
    }

    private static MotionEvent make(long downTime, long when, int action, float x, float y,
                                    float pressure, float size) {
        MotionEvent.PointerProperties props = new MotionEvent.PointerProperties();
        props.id = 0;
        props.toolType = MotionEvent.TOOL_TYPE_FINGER;

        MotionEvent.PointerCoords coords = new MotionEvent.PointerCoords();
        coords.x = x;
        coords.y = y;
        coords.pressure = pressure;
        coords.size = size;
        // 24px 的接触半径 ≈ 5mm 手指在 480dpi 屏上的投影，给系统一个合理值
        coords.toolMajor = 24f;
        coords.toolMinor = 24f;
        coords.touchMajor = 24f;
        coords.touchMinor = 24f;

        return MotionEvent.obtain(
                downTime, when, action, 1,
                new MotionEvent.PointerProperties[]{props},
                new MotionEvent.PointerCoords[]{coords},
                0, 0, 1f, 1f, 0, 0,
                InputDevice.SOURCE_TOUCHSCREEN, 0);
    }

    /** 单点按下-保持-抬起。按绝对时间调度，避免注入开销把时长撑大。 */
    private static String tap(float x, float y, int downMs) {
        int hold = Math.max(1, downMs);
        long downTime = SystemClock.uptimeMillis();
        long endTime = downTime + hold;
        if (!inject(make(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, defaultPressure, defaultSize))) {
            return "err down-rejected";
        }

        // 轻点用 8ms 一帧（像真手指），长按用 24ms 一帧（真按住不动时事件本来就稀）。
        long stepMs = hold > 300 ? 24 : 8;
        int i = 0;
        while (true) {
            long now = SystemClock.uptimeMillis();
            if (now + stepMs >= endTime) break;
            sleepQuietly(stepMs);
            now = SystemClock.uptimeMillis();
            if (now + 2 >= endTime) break;
            i++;
            float k = Math.min(1f, (float) (now - downTime) / hold);
            float p = defaultPressure - 0.10f + 0.20f * k;
            float jx = x + (((i * 37) % 3) - 1) * 0.4f;
            float jy = y + (((i * 53) % 3) - 1) * 0.4f;
            inject(make(downTime, now, MotionEvent.ACTION_MOVE, jx, jy, p, defaultSize));
        }

        long now = SystemClock.uptimeMillis();
        if (endTime > now) {
            sleepQuietly(endTime - now);
        }
        long upTime = SystemClock.uptimeMillis();
        boolean ok = inject(make(downTime, upTime, MotionEvent.ACTION_UP, x, y, 0.0f, defaultSize));
        return ok ? "ok tap hold=" + (upTime - downTime) + "ms moves=" + i : "err up-rejected";
    }

    /**
     * 按住不动：DOWN → 睡 → UP，中间**不发任何 MOVE**。
     *
     * 这一条是实测踩出来的：微信消息气泡的长按只要收到 MOVE 就会被取消
     * （列表行的长按却容忍 MOVE）。真人按住不动时本来也不产生中间事件，
     * 所以这才是「长按」的正确形态。
     */
    private static String holdStill(float x, float y, int holdMs) {
        int hold = Math.max(30, holdMs);
        long downTime = SystemClock.uptimeMillis();
        if (!inject(make(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, defaultPressure, defaultSize))) {
            return "err down-rejected";
        }
        sleepQuietly(hold);
        long upTime = SystemClock.uptimeMillis();
        boolean ok = inject(make(downTime, upTime, MotionEvent.ACTION_UP, x, y, 0.0f, defaultSize));
        return ok ? "ok hold hold=" + (upTime - downTime) + "ms moves=0" : "err up-rejected";
    }

    private static String swipe(float x1, float y1, float x2, float y2, int durationMs) {
        int ms = Math.max(20, durationMs);
        long downTime = SystemClock.uptimeMillis();
        if (!inject(make(downTime, downTime, MotionEvent.ACTION_DOWN, x1, y1, defaultPressure, defaultSize))) {
            return "err down-rejected";
        }
        int steps = Math.max(2, ms / 10);
        for (int i = 1; i < steps; i++) {
            long target = downTime + (long) ms * i / steps;
            long now = SystemClock.uptimeMillis();
            if (target > now) {
                sleepQuietly(target - now);
            }
            float k = (float) i / steps;
            // 末段减速：用 1-(1-k)^2 近似人类滑动收尾
            float e = 1f - (1f - k) * (1f - k);
            float x = x1 + (x2 - x1) * e;
            float y = y1 + (y2 - y1) * e;
            inject(make(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_MOVE, x, y,
                    defaultPressure, defaultSize));
        }
        long targetEnd = downTime + ms;
        long now = SystemClock.uptimeMillis();
        if (targetEnd > now) {
            sleepQuietly(targetEnd - now);
        }
        long upTime = SystemClock.uptimeMillis();
        boolean ok = inject(make(downTime, upTime, MotionEvent.ACTION_UP, x2, y2, 0.0f, defaultSize));
        return ok ? "ok swipe " + (upTime - downTime) + "ms steps=" + steps : "err up-rejected";
    }

    /** 逐点轨迹：每点 "x,y,t"（t 为相对毫秒），最后一点之后 40ms 抬起。 */
    private static String path(String[] points) {
        if (points.length < 2) {
            return "err path 至少两个点";
        }
        long downTime = SystemClock.uptimeMillis();
        float[] first = parsePoint(points[0]);
        if (!inject(make(downTime, downTime, MotionEvent.ACTION_DOWN, first[0], first[1],
                defaultPressure, defaultSize))) {
            return "err down-rejected";
        }
        long lastT = 0;
        for (int i = 1; i < points.length; i++) {
            float[] p = parsePoint(points[i]);
            lastT = (long) p[2];
            long target = downTime + lastT;
            long now = SystemClock.uptimeMillis();
            if (target > now) {
                sleepQuietly(target - now);
            }
            inject(make(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_MOVE, p[0], p[1],
                    defaultPressure, defaultSize));
        }
        sleepQuietly(40);
        float[] last = parsePoint(points[points.length - 1]);
        long upTime = SystemClock.uptimeMillis();
        boolean ok = inject(make(downTime, upTime, MotionEvent.ACTION_UP, last[0], last[1], 0.0f, defaultSize));
        return ok ? "ok path points=" + points.length + " span=" + (upTime - downTime) + "ms"
                : "err up-rejected";
    }

    private static float[] parsePoint(String token) {
        String[] parts = token.split(",");
        if (parts.length < 2) {
            throw new IllegalArgumentException("点格式应为 x,y 或 x,y,t：" + token);
        }
        float x = Float.parseFloat(parts[0].trim());
        float y = Float.parseFloat(parts[1].trim());
        float t = parts.length >= 3 ? Float.parseFloat(parts[2].trim()) : 0f;
        return new float[]{x, y, t};
    }

    // ---------------- 命令解析 ----------------

    private static String handle(String line) {
        if (line.isEmpty()) {
            return "ok idle";
        }
        String[] tok = line.split("\\s+");
        String cmd = tok[0];

        if (cmd.equals("ping")) {
            return "ok pong";
        }
        if (cmd.equals("info")) {
            return "ok uid=" + currentUid()
                    + " injected=" + injected
                    + " failed=" + failed
                    + " pressure=" + defaultPressure
                    + " size=" + defaultSize
                    + " manager=" + (inputManager == null ? "null" : inputManager.getClass().getName());
        }
        if (cmd.equals("press")) {
            if (tok.length < 3) {
                return "err press 需要 <pressure> <size>";
            }
            float p = Float.parseFloat(tok[1]);
            float s = Float.parseFloat(tok[2]);
            if (p < 0f || p > 1f || s < 0f || s > 1f) {
                return "err pressure/size 必须在 0..1";
            }
            defaultPressure = p;
            defaultSize = s;
            return "ok press=" + p + " size=" + s;
        }
        if (cmd.equals("tap")) {
            if (tok.length < 4) {
                return "err tap 需要 <x> <y> <ms>";
            }
            return tap(Float.parseFloat(tok[1]), Float.parseFloat(tok[2]), Integer.parseInt(tok[3]));
        }
        if (cmd.equals("hold")) {
            if (tok.length < 4) {
                return "err hold 需要 <x> <y> <ms>";
            }
            return holdStill(Float.parseFloat(tok[1]), Float.parseFloat(tok[2]), Integer.parseInt(tok[3]));
        }
        if (cmd.equals("swipe")) {
            if (tok.length < 6) {
                return "err swipe 需要 <x1> <y1> <x2> <y2> <ms>";
            }
            return swipe(Float.parseFloat(tok[1]), Float.parseFloat(tok[2]),
                    Float.parseFloat(tok[3]), Float.parseFloat(tok[4]), Integer.parseInt(tok[5]));
        }
        if (cmd.equals("path")) {
            String[] pts = new String[tok.length - 1];
            System.arraycopy(tok, 1, pts, 0, pts.length);
            return path(pts);
        }
        if (cmd.equals("log")) {
            // 把最近状态写一份到设备上，便于 adb shell cat 取回
            String path = "/data/local/tmp/mimic-injector.log";
            try (FileWriter w = new FileWriter(path)) {
                w.write("injected=" + injected + " failed=" + failed
                        + " pressure=" + defaultPressure + " size=" + defaultSize + "\n");
            } catch (Throwable t) {
                return "err log " + describe(t);
            }
            return "ok log=" + path;
        }
        return "err 未知命令：" + cmd;
    }

    // ---------------- 小工具 ----------------

    private static void sleepQuietly(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static String currentUid() {
        try {
            Class<?> process = Class.forName("android.os.Process");
            Method myUid = process.getMethod("myUid");
            return String.valueOf(myUid.invoke(null));
        } catch (Throwable t) {
            return "?";
        }
    }

    private static String describe(Throwable t) {
        Throwable cause = t;
        while (cause.getCause() != null) {
            cause = cause.getCause();
        }
        String msg = cause.getClass().getSimpleName() + ":" + String.valueOf(cause.getMessage());
        return msg.replace('\n', ' ').replace('\r', ' ');
    }
}