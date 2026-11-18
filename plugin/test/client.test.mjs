// 不改真实 DSH：用假的 window.__ModuleLoader__ / React 验证 client.js 的加载与槽位注册，
// 并把「还没读到数据」时的加载态渲染一遍，catch 明显的运行时错误。
import test from "node:test";
import assert from "node:assert/strict";

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(config) {
      captured = config;
    },
  },
};

await import("../client.js");

function fakeReact() {
  const elements = [];
  return {
    elements,
    React: {
      createElement(type, props, ...children) {
        const element = { type, props, children };
        elements.push(element);
        return element;
      },
      useState(initial) {
        return [initial, () => {}];
      },
      useEffect() {},
      useRef(value) {
        return { current: value };
      },
      useCallback(fn) {
        return fn;
      },
    },
  };
}

test("client.js 注册到 settings.section，id/label 正确", () => {
  assert.ok(captured, "没有捕获到 __ModuleLoader__.load");
  assert.equal(captured.id, "dsh-mimicd-wechat");
  assert.equal(typeof captured.factory, "function");
});

test("client apply 注册 mimicd-wechat 设置区，加载态可渲染", () => {
  const { React } = fakeReact();
  const mod = captured.factory((name) => {
    assert.equal(name, "react");
    return React;
  });
  assert.equal(typeof mod.apply, "function");

  let registered = null;
  const ctx = {
    slots: {
      inject(name, cb) {
        assert.equal(name, "settings.section");
        cb();
      },
      register(spec, component) {
        registered = { spec, component };
        return () => {};
      },
    },
  };
  mod.apply(ctx);

  assert.ok(registered);
  assert.equal(registered.spec.name, "settings.section");
  assert.equal(registered.spec.id, "mimicd-wechat");
  assert.equal(registered.spec.label(), "mimicd 微信");

  const tree = registered.component({});
  assert.ok(tree, "组件应返回元素树");
  assert.equal(tree.type, "div");
});