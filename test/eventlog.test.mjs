import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SCHEMA_VERSION } from "../src/events.ts";
import { EventLog, EventLogFormatError, parseEventLine, readEvents } from "../src/eventlog.ts";
import { ArtifactStore } from "../src/artifacts.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "mimicd-"));
}

test("事件按 seq 递增落盘，可原样回读", () => {
  const root = tmp();
  const log = new EventLog({
    file: join(root, "run.jsonl"),
    run: "r-test",
    now: () => 1700000000000,
    mono: () => 1234.6,
  });

  log.append("run.started", { pid: 42, node: process.version });
  log.append("frame.captured", { page: "chat" }, { src: "perception.screencap" });
  log.append("send.succeeded", { chat: "张三", bytes: 12 }, { src: "act.send" });
  log.close();

  const events = readEvents(log.file);
  assert.equal(events.length, 4);
  assert.deepEqual(
    events.map((e) => e.seq),
    [1, 2, 3, 4],
  );
  assert.equal(events[1]?.kind, "frame.captured");
  assert.equal(events[1]?.src, "perception.screencap");
  assert.equal(events[0]?.mono, 1235); // 取整
  assert.equal(events[3]?.kind, "run.stopped");

  // id 唯一且可读
  const ids = new Set(events.map((e) => e.id));
  assert.equal(ids.size, 4);
  assert.ok(events[2].id.startsWith("r-test:"));
});

test("事件里不出现 base64，只出现工件引用", () => {
  const root = tmp();
  const log = new EventLog({ file: join(root, "run.jsonl"), run: "r-ref" });
  const store = new ArtifactStore(root);

  // 假装是一帧 1080x2160 的截图（实际字节随便）
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
  const ref = store.put({ buf: png, ext: "png", w: 1080, h: 2160 });

  assert.equal(ref.path.startsWith("artifacts/"), true);
  assert.equal(ref.sha256.length, 64);
  assert.equal(ref.w, 1080);

  log.append("frame.captured", { page: "list" }, { refs: [ref] });

  const text = readFileSync(log.file, "utf8");
  assert.equal(text.includes("base64"), false);
  assert.equal(text.includes(png.toString("base64")), false);
  assert.equal(text.includes(ref.sha256), true);

  const [event] = readEvents(log.file);
  assert.equal(event.refs?.[0]?.path, ref.path);
  assert.equal(store.verify(ref).ok, true);
});

test("同一内容重复 put 不重复落盘，路径稳定", () => {
  const root = tmp();
  const store = new ArtifactStore(root);
  const buf = Buffer.from("same-bytes");
  const a = store.put({ buf, ext: "txt", at: 1700000000000 });
  const b = store.put({ buf, ext: "txt", at: 1700000000000 });
  assert.equal(a.path, b.path);
  assert.equal(a.sha256, b.sha256);
  assert.equal(store.verify(a).ok, true);
});

test("拒绝来自未来版本的事件，而不是猜着读", () => {
  const future = JSON.stringify({
    v: SCHEMA_VERSION + 1,
    seq: 1,
    id: "x:1",
    t: 1,
    mono: 1,
    run: "x",
    kind: "frame.captured",
    src: "test",
    data: {},
  });
  assert.throws(() => parseEventLine(future, 7), (err) => {
    assert.ok(err instanceof EventLogFormatError);
    assert.match(err.message, /schema 版本/);
    assert.match(err.message, /第 7 行/);
    return true;
  });
});

test("seq 断档/回退会被发现", () => {
  const root = tmp();
  const file = join(root, "bad.jsonl");
  const base = {
    v: SCHEMA_VERSION,
    id: "x",
    t: 1,
    mono: 1,
    run: "x",
    kind: "note",
    src: "test",
    data: {},
  };
  writeFileSync(
    file,
    [JSON.stringify({ ...base, seq: 1 }), JSON.stringify({ ...base, seq: 1 })].join("\n") + "\n",
    "utf8",
  );
  assert.throws(() => readEvents(file), /seq 未递增/);
});

test("未知 kind 能读出来（前向兼容靠回放侧忽略，不靠写入侧克制）", () => {
  const line = JSON.stringify({
    v: SCHEMA_VERSION,
    seq: 9,
    id: "x:9",
    t: 1,
    mono: 1,
    run: "x",
    kind: "future.thing",
    src: "test",
    data: { a: 1 },
  });
  const env = parseEventLine(line);
  assert.equal(env.kind, "future.thing");
});

test("afterSeq 断点续跑", () => {
  const root = tmp();
  const log = new EventLog({ file: join(root, "run.jsonl"), run: "r-cp" });
  for (let i = 0; i < 5; i++) log.append("note", { i });
  const rest = readEvents(log.file, { afterSeq: 3 });
  assert.deepEqual(
    rest.map((e) => e.seq),
    [4, 5],
  );
});