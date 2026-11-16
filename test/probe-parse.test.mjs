import { test } from "node:test";
import assert from "node:assert/strict";

import { parseA11yXml, parseFramestats, parseNotifications, summarizeState, unxml } from "../tools/probe/parse.ts";

const A11Y_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.tencent.mm" content-desc="" clickable="false" bounds="[0,0][1080,2160]">
  <node index="0" text="微信" resource-id="" class="android.widget.TextView" package="com.tencent.mm" content-desc="" clickable="false" bounds="[60,180][240,260]" />
  <node index="1" text="搜索" resource-id="com.tencent.mm:id/ka" class="android.widget.EditText" package="com.tencent.mm" content-desc="搜索框，双击输入" clickable="true" bounds="[300,200][900,300]" />
  <node index="2" text="" resource-id="" class="android.view.View" package="com.tencent.mm" content-desc="" clickable="false" bounds="[0,400][1080,2000]" />
</node></hierarchy>`;

test("a11y：数节点、取文本、识别「只有一层壳」", () => {
  const s = parseA11yXml(A11Y_XML);
  assert.equal(s.nodes, 4);
  assert.equal(s.withText, 2);
  assert.equal(s.withDesc, 1);
  assert.equal(s.clickable, 1);
  assert.deepEqual(s.packages, ["com.tencent.mm"]);
  assert.deepEqual(s.texts, ["微信", "搜索", "[desc] 搜索框，双击输入"]);
  assert.equal(s.classes["android.widget.FrameLayout"], 1);
});

test("a11y：整棵树只有一个空节点时，结论是「不可用」", () => {
  const onlyShell = `<hierarchy rotation="0"><node index="0" text="" class="android.widget.FrameLayout" package="com.tencent.mm" content-desc="" clickable="false" bounds="[0,0][1080,2160]" /></hierarchy>`;
  const s = parseA11yXml(onlyShell);
  assert.equal(s.nodes, 1);
  assert.equal(s.withText, 0);
});

test("XML 实体解码，别把 &amp; 原样塞进文本", () => {
  assert.equal(unxml("A &amp; B &lt;x&gt; &quot;q&quot;"), 'A & B <x> "q"');
});

const NOTIF = `NotificationRecord(0x1234: pkg=com.tencent.mm user=UserHandle{0} id=5)
    uid=10123 userId=0
    android.title=String (张三)
    android.text=String (晚上一起吃饭吗)
    flags=0x00000011
NotificationRecord(0x5678: pkg=com.tencent.mm user=UserHandle{0} id=6)
    android.title=String (李四)
    android.bigText=String (明天会议改到三点)
NotificationRecord(0x9999: pkg=com.android.systemui user=UserHandle{0} id=1)
    android.title=String (系统更新)`;

test("通知：按包名过滤，标题 + 正文/长文", () => {
  const items = parseNotifications(NOTIF);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { title: "张三", text: "晚上一起吃饭吗" });
  assert.deepEqual(items[1], { title: "李四", text: "明天会议改到三点" });
});

test("通知：其它应用的通知不算进来", () => {
  const items = parseNotifications(NOTIF, "com.android.systemui");
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "系统更新");
});

const GFX = `Applications Graphics Acceleration Info:
---PROFILEDATA---
Flags,IntendedVsync,Vsync,OldestInputEvent,NewestInputEvent,HandleInputStart,AnimationStart,PerformTraversalsStart,DrawStart,SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,DequeueBufferDuration,QueueBufferDuration,GpuCompleted,
0,100,100,0,0,1,2,3,4,5,6,7,8,9,1000,2000,0,
0,200,200,0,0,1,2,3,4,5,6,7,8,9,1000,2000,0,
0,300,300,0,0,1,2,3,4,5,6,7,8,9,1000,2000,0,
---PROFILEDATA---`;

test("gfxinfo：数帧数、列数、段数", () => {
  const f = parseFramestats(GFX);
  assert.equal(f.frames, 3);
  assert.equal(f.columns, 17);
  assert.equal(f.segments, 1);
});

test("gfxinfo：没有 profile 数据时给 0，不抛异常", () => {
  const f = parseFramestats("Graphics info for com.tencent.mm\n");
  assert.equal(f.frames, 0);
});

test("状态摘要只拼有的字段", () => {
  assert.equal(
    summarizeState({ wakefulness: "Awake", focus: "mCurrentFocus=Window{com.tencent.mm}", ime: "com.baidu.input_huawei/.ImeService" }),
    "屏幕:Awake · 前台:mCurrentFocus=Window{com.tencent.mm} · 输入法:com.baidu.input_huawei",
  );
  assert.equal(summarizeState({}), "");
});