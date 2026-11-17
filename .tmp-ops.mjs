import fs from "node:fs"; import path from "node:path";
const implSrc = fs.readFileSync(new URL("./src/skills/runner.ts", import.meta.url), "utf8");
const impl = new Set([...implSrc.matchAll(/case "([a-z_.]+)"/g)].map(m => m[1]));
const files = []; (function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(p.endsWith(".json"))files.push(p);}})("skills");
const used = new Map();
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f,"utf8"));
  const visit = (steps) => { for (const s of steps||[]) {
    if (s.op) { if(!used.has(s.op)) used.set(s.op,new Set()); used.get(s.op).add(path.basename(f)); }
    if (s.then) visit([s.then]); if (s.else) visit([s.else]); if (s.steps) visit(s.steps);
    if (s.branch) for (const b of s.branch) visit(b.steps);
  }};
  visit(j.steps);
}
console.log("--- used ops ---");
for (const [op, fs2] of used) console.log((impl.has(op) ? "ok  " : "MISS"), op, [...fs2].join(","));
