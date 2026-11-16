package mimic.probe;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.inputmethodservice.InputMethodService;
import android.util.Log;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;

/**
 * 自建输入法：唯一的目的是**读**。
 *
 *  Android 10 起，剪贴板只对「默认输入法」和焦点应用开放；
 *  普通后台进程（包括 adb shell）读不到（实测 cmd clipboard get 无实现、
 *  service call clipboard 2 返回空 Parcel）。
 *  作为默认输入法，这里可以：
 *    - getCurrentInputConnection().getTextBeforeCursor()：读输入框里已有的文本（零 OCR 误差）
 *    - ClipBoardManager.getPrimaryClip()：读剪贴板
 *  顺带也能写入（commitText / setPrimaryClip）。
 */
public class ProbeIme extends InputMethodService {

    private static final String TAG = "MimicIme";
    public static ProbeIme instance;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        Log.i(TAG, "ime-created");
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Override
    public void onStartInput(EditorInfo info, boolean restarting) {
        super.onStartInput(info, restarting);
        Log.i(TAG, "start-input pkg=" + (info == null ? "?" : info.packageName)
                + " inputType=" + (info == null ? 0 : info.inputType));
    }

    /**
     * 不显示任何键盘 UI。
     *
     * 必要性：一旦弹出键盘，微信的输入栏会被顶到屏幕中间，发送按钮的坐标全变；
     * 我们只需要 InputConnection 来提交/读取文本，不需要给人用的键盘。
     */
    @Override
    public boolean onEvaluateInputViewShown() {
        return false;
    }

    /** 输入框里光标前的文本 + 光标后的文本。 */
    public String readEditor() {
        InputConnection ic = getCurrentInputConnection();
        if (ic == null) {
            return "ERR no-input-connection";
        }
        try {
            CharSequence before = ic.getTextBeforeCursor(500, 0);
            CharSequence after = ic.getTextAfterCursor(200, 0);
            return "BEFORE=" + (before == null ? "" : before.toString())
                    + "||AFTER=" + (after == null ? "" : after.toString());
        } catch (Throwable t) {
            return "ERR " + t;
        }
    }

    /** 剪贴板内容（默认输入法才有豁免）。 */
    public String readClipboard() {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) {
                return "EMPTY";
            }
            CharSequence text = clip.getItemAt(0).coerceToText(this);
            return "CLIP=" + (text == null ? "" : text.toString());
        } catch (Throwable t) {
            return "ERR " + t;
        }
    }

    public String setClipboard(String text) {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("mimic", text));
            return "ok";
        } catch (Throwable t) {
            return "ERR " + t;
        }
    }

    public String commit(String text) {
        InputConnection ic = getCurrentInputConnection();
        if (ic == null) {
            return "ERR no-input-connection";
        }
        ic.commitText(text, 1);
        return "ok committed=" + text.length();
    }
}