package mimic.probe;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;

/**
 * 外部遥控入口。adb shell am broadcast -a <动作> -p mimic.probe [--es text ...]
 *
 * 读到的内容同时写 logcat（tag=MimicCmd）和 files/cmd.jsonl，
 * 因为 shell 不一定能直接读应用的私有目录。
 */
public class CommandReceiver extends BroadcastReceiver {

    private static final String TAG = "MimicCmd";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent == null ? "" : String.valueOf(intent.getAction());
        String result;
        try {
            result = handle(ctx, action, intent);
        } catch (Throwable t) {
            result = "ERR " + t;
        }
        Log.i(TAG, action + " => " + result);
        write(ctx, "{\"action\":\"" + action + "\",\"result\":" + jsonString(result) + "}");
    }

    private String handle(Context ctx, String action, Intent intent) throws Exception {
        switch (action) {
            case "mimic.PING":
                return "ok ime=" + (ProbeIme.instance != null);
            case "mimic.READ_INPUT":
                return ProbeIme.instance == null ? "ERR no-ime-instance" : ProbeIme.instance.readEditor();
            case "mimic.READ_CLIPBOARD":
                return ProbeIme.instance == null ? "ERR no-ime-instance" : ProbeIme.instance.readClipboard();
            case "mimic.SET_CLIPBOARD":
                return ProbeIme.instance == null
                        ? "ERR no-ime-instance"
                        : ProbeIme.instance.setClipboard(String.valueOf(intent.getStringExtra("text")));
            case "mimic.TYPE":
                return ProbeIme.instance == null
                        ? "ERR no-ime-instance"
                        : ProbeIme.instance.commit(String.valueOf(intent.getStringExtra("text")));
            case "mimic.CLEAR":
                return clear(ctx);
            default:
                return "ERR unknown action " + action;
        }
    }

    private String clear(Context ctx) {
        File dir = ctx.getExternalFilesDir(null);
        if (dir == null) {
            return "ERR no-external-dir";
        }
        int removed = 0;
        File[] files = dir.listFiles();
        if (files != null) {
            for (File f : files) {
                if (f.isFile() && f.getName().endsWith(".jsonl") && f.delete()) {
                    removed++;
                }
            }
        }
        return "ok removed=" + removed;
    }

    private void write(Context ctx, String line) {
        File dir = ctx.getExternalFilesDir(null);
        if (dir == null) {
            return;
        }
        try (FileWriter w = new FileWriter(new File(dir, "cmd.jsonl"), true)) {
            w.write(line);
            w.write("\n");
        } catch (IOException ignored) {
            // logcat 里还有一份
        }
    }

    private static String jsonString(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"";
    }
}