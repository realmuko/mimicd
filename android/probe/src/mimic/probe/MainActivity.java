package mimic.probe;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.util.Locale;

/**
 * 触摸参数探针：把收到的每个 MotionEvent 原样记下来。
 *
 * 用途：证明「注入器设的 pressure/downMs 真的到了应用这一侧」。
 * 关注四个字段：deviceId（注入事件应恒为 -1）、pressure、size、eventTime - downTime。
 */
public class MainActivity extends Activity {

    private static final String TAG = "MimicTouch";
    private TextView out;
    private ScrollView scroll;
    private int count = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        scroll = new ScrollView(this);
        out = new TextView(this);
        out.setTextSize(13f);
        out.setPadding(28, 60, 28, 28);
        out.setText("MimicProbe · 触摸参数\n（在任意位置按住/点击/滑动，这里会显示原始 MotionEvent）\n");
        scroll.addView(out);
        setContentView(scroll);

        // 兜住所有触摸：不依赖某个 View 的命中区域（TextView 只占内容高度，空白区收不到）
        scroll.setFillViewport(true);
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent e) {
        record(e);
        return super.dispatchTouchEvent(e);
    }

    private void record(MotionEvent e) {
        int action = e.getActionMasked();
        long hold = e.getEventTime() - e.getDownTime();
        String line = String.format(Locale.US,
                "{\"n\":%d,\"action\":\"%s\",\"x\":%.1f,\"y\":%.1f,\"pressure\":%.3f,\"size\":%.3f,"
                        + "\"toolMajor\":%.1f,\"deviceId\":%d,\"source\":%d,\"downToEvent\":%d,"
                        + "\"eventTime\":%d,\"history\":%d,\"pointers\":%d}",
                ++count, actionName(action), e.getX(), e.getY(),
                e.getPressure(), e.getSize(), e.getToolMajor(),
                e.getDeviceId(), e.getSource(), hold,
                e.getEventTime(), e.getHistorySize(), e.getPointerCount());

        Log.i(TAG, line);
        appendFile(line);

        // 屏幕上只留最近 12 条，避免滚动太多
        String[] lines = out.getText().toString().split("\n");
        StringBuilder sb = new StringBuilder();
        int keep = action == MotionEvent.ACTION_DOWN ? 8 : 12;
        int from = Math.max(0, lines.length - keep);
        for (int i = from; i < lines.length; i++) {
            sb.append(lines[i]).append('\n');
        }
        sb.append(shortLine(action, e, hold));
        out.setText(sb.toString());
        scroll.post(new Runnable() {
            @Override
            public void run() {
                scroll.fullScroll(View.FOCUS_DOWN);
            }
        });
    }

    private String shortLine(int action, MotionEvent e, long hold) {
        return String.format(Locale.US, "%s  p=%.2f s=%.2f dt=%dms  dev=%d",
                actionName(action), e.getPressure(), e.getSize(), hold, e.getDeviceId());
    }

    private static String actionName(int action) {
        switch (action) {
            case MotionEvent.ACTION_DOWN: return "DOWN";
            case MotionEvent.ACTION_UP: return "UP";
            case MotionEvent.ACTION_MOVE: return "MOVE";
            case MotionEvent.ACTION_CANCEL: return "CANCEL";
            default: return String.valueOf(action);
        }
    }

    private void appendFile(String line) {
        File dir = getExternalFilesDir(null);
        if (dir == null) {
            return;
        }
        File f = new File(dir, "touch.jsonl");
        try (FileWriter w = new FileWriter(f, true)) {
            w.write(line);
            w.write("\n");
        } catch (IOException ignored) {
            // 写不进去也不影响屏幕显示（还能从 logcat 取）
        }
    }
}