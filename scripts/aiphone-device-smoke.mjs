#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(rootDir, 'tool-gateway', '.smoke');
mkdirSync(outDir, { recursive: true });

const defaultQueries = [
  '你好',
  '帮我查明天北京到上海航班',
  '帮我查明天北京到上海高铁票',
  '帮我查询深圳北出发到香港西九龙明天晚上六点之后的高铁',
  '帮我查附近咖啡',
  '我想明天从北京去上海，帮我整理可查的出行选项'
];

const forbiddenSyntheticMarkers = [
  'local://aiphone-tools',
  '本机工具',
  '本机模式',
  '高铁 G 字头',
  '动车 D 字头',
  '直飞航班',
  '早晚低峰',
  '附近咖啡优先',
  '安静办公优先',
  '连锁稳定优先',
  '可查选项'
];

const visibleDomainMarkers = [
  '北京',
  '上海',
  '深圳',
  '高铁',
  '航班',
  '12306',
  '飞常准',
  '餐饮',
  '咖啡',
  '多展示一些',
  '选最快的'
];

const forbiddenLayoutActionMarkers = [
  '换个时间',
  '换个车站'
];

const finalLayoutBlockingMarkers = [
  'A2UI 流解析失败',
  '模型正在思考',
  '暂无可展示数据',
  '把一句话变成可执行界面',
  '告诉 AIPhone 你要安排的事',
  '车次',
  '航班号',
  '最快',
  '飞行时间',
  '小时',
  '分钟',
  '[',
  ']'
];

const finalLayoutRouteMarkers = [
  '北京',
  '上海'
];

const finalLayoutBlockingPatterns = [
  { name: 'iso-date', pattern: /\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/ },
  { name: 'zh-date', pattern: /\b\d{4}年\d{1,2}月\d{1,2}日\b/ }
];

const queries = process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaultQueries;
const target = process.env.AIPHONE_HDC_TARGET || firstTarget();
const timeoutMs = Number.parseInt(process.env.AIPHONE_QUERY_TIMEOUT_MS || '90000', 10);

function firstTarget() {
  const result = spawnSync('hdc', ['list', 'targets'], { encoding: 'utf8' });
  const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new Error('No hdc target found. Set AIPHONE_HDC_TARGET.');
  }
  return lines[0];
}

function hdc(args, options = {}) {
  const result = spawnSync('hdc', ['-t', target, ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...options
  });
  if (result.status !== 0) {
    throw new Error(`hdc ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) {
    walk(child, visit);
  }
}

function center(bounds) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(bounds || '');
  if (!match) {
    return null;
  }
  const left = Number.parseInt(match[1], 10);
  const top = Number.parseInt(match[2], 10);
  const right = Number.parseInt(match[3], 10);
  const bottom = Number.parseInt(match[4], 10);
  return {
    x: Math.floor((left + right) / 2),
    y: Math.floor((top + bottom) / 2)
  };
}

function dumpLayout(localName = 'latest-layout.json') {
  const remote = '/data/local/tmp/aiphone-smoke-layout.json';
  const local = join(outDir, localName);
  hdc(['shell', 'uitest', 'dumpLayout', '-p', remote, '-b', 'com.example.aiphonedemo']);
  hdc(['file', 'recv', remote, local]);
  return JSON.parse(spawnSync('cat', [local], { encoding: 'utf8' }).stdout);
}

function collectLayoutText(layout) {
  const values = [];
  walk(layout, (node) => {
    const attrs = node.attributes || {};
    ['text', 'content', 'description', 'hint'].forEach((key) => {
      const value = attrs[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        values.push(value.trim());
      }
    });
  });
  return [...new Set(values)];
}

function findControls(layout) {
  let input = null;
  let generate = null;
  walk(layout, (node) => {
    const attrs = node.attributes || {};
    if (attrs.type === 'TextInput' && input === null) {
      input = center(attrs.bounds);
    }
    if (attrs.type === 'Button' && attrs.text === '生成') {
      generate = center(attrs.bounds);
    }
  });
  if (input === null || generate === null) {
    throw new Error('Could not locate AIPhone input/generate controls.');
  }
  return { input, generate };
}

function lineMatchesPid(line, pid) {
  if (pid.length === 0) {
    return true;
  }
  return line.indexOf(` ${pid} `) >= 0;
}

async function captureWhile(appPid, runAction) {
  const logs = [];
  const child = spawn('hdc', ['-t', target, 'hilog'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let buffer = '';
  const onData = (chunk) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const line of parts) {
      if (lineMatchesPid(line, appPid) && (line.includes('AIPhone') || line.includes('aiphonedemo') || line.includes('NETSTACK') || line.includes('11434'))) {
        logs.push(line);
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  await sleep(800);
  await runAction();

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(500);
    const text = logs.join('\n');
    if (/\[AIPhone\]\[ToolResult\] ok=/.test(text) || /\[AIPhone\]\[ToolRequest\] none/.test(text) || /\[AIPhone\]\[ModelResult\] ok=false/.test(text)) {
      break;
    }
  }
  child.kill('SIGTERM');
  await sleep(300);
  return logs;
}

function activeHilogProcesses() {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('hdc') && line.includes('hilog'));
}

function analyze(query, logs) {
  const text = logs.join('\n');
  const needsTool = /航班|高铁|火车|车票|咖啡|附近/.test(query) && !/整理可查的出行选项/.test(query);
  const result = {
    query,
    model200: /\[AIPhone\]\[ModelStreamResponse\] code=200/.test(text) || /response_code":200[\s\S]*dst_port":11434/.test(text),
    modelOk: /\[AIPhone\]\[ModelResult\] ok=true/.test(text),
    toolRequested: /\[AIPhone\]\[ToolRequest\] toolId=/.test(text),
    toolOk: /\[AIPhone\]\[ToolResult\] ok=true/.test(text),
    failedConnect: /failed to connect|Could not connect|ECONNREFUSED|server is not running/i.test(text),
    modelFailed: /\[AIPhone\]\[ModelResult\] ok=false/.test(text),
    toolNone: /\[AIPhone\]\[ToolRequest\] none/.test(text),
    syntheticFallback: forbiddenSyntheticMarkers.some((marker) => text.includes(marker))
  };
  result.ok = result.model200 &&
    !result.failedConnect &&
    !result.syntheticFallback &&
    (needsTool ? (result.toolRequested && result.toolOk) : (result.modelOk && !result.modelFailed && !result.toolRequested));
  return result;
}

async function runQuery(query, index) {
  hdc(['shell', 'aa', 'force-stop', 'com.example.aiphonedemo']);
  hdc(['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', 'com.example.aiphonedemo']);
  await sleep(2200);
  const appPid = hdc(['shell', 'pidof', 'com.example.aiphonedemo']).trim().split(/\s+/)[0] || '';
  const controls = findControls(dumpLayout());
  const logs = await captureWhile(appPid, async () => {
    hdc(['shell', 'uitest', 'uiInput', 'click', String(controls.input.x), String(controls.input.y)]);
    hdc(['shell', 'uitest', 'uiInput', 'keyEvent', '2072', '2017']);
    hdc(['shell', 'uitest', 'uiInput', 'keyEvent', '2055']);
    hdc(['shell', 'uitest', 'uiInput', 'inputText', String(controls.input.x), String(controls.input.y), query]);
    await sleep(1000);
    const updatedControls = findControls(dumpLayout());
    hdc(['shell', 'uitest', 'uiInput', 'click', String(updatedControls.generate.x), String(updatedControls.generate.y)]);
  });
  const logPath = join(outDir, `query-${index + 1}.log`);
  writeFileSync(logPath, logs.join('\n') + '\n');
  const summary = analyze(query, logs);
  summary.logPath = logPath;
  return summary;
}

const summaries = [];
for (let index = 0; index < queries.length; index += 1) {
  const query = queries[index];
  console.log(`\n[${index + 1}/${queries.length}] ${query}`);
  const summary = await runQuery(query, index);
  summaries.push(summary);
  console.log(JSON.stringify(summary, null, 2));
}

const finalLayout = dumpLayout('final-layout.json');
const finalLayoutTextValues = collectLayoutText(finalLayout);
const finalLayoutText = finalLayoutTextValues.join('\n');
const finalLayoutTextPath = join(outDir, 'final-layout-text.txt');
writeFileSync(finalLayoutTextPath, finalLayoutText + '\n');
const finalLayoutDomainHits = visibleDomainMarkers.filter((marker) => finalLayoutText.includes(marker));
const finalLayoutSyntheticHits = forbiddenSyntheticMarkers.filter((marker) => finalLayoutText.includes(marker));
const finalLayoutForbiddenActionHits = forbiddenLayoutActionMarkers.filter((marker) => finalLayoutText.includes(marker));
const finalLayoutBlockingHits = finalLayoutBlockingMarkers.filter((marker) => finalLayoutText.includes(marker));
for (const blockingPattern of finalLayoutBlockingPatterns) {
  if (blockingPattern.pattern.test(finalLayoutText)) {
    finalLayoutBlockingHits.push(blockingPattern.name);
  }
}
const finalLayoutRouteHits = finalLayoutRouteMarkers.filter((marker) => finalLayoutText.includes(marker));
const hilogProcesses = activeHilogProcesses();
const visibleOutput = {
  layoutPath: join(outDir, 'final-layout.json'),
  textPath: finalLayoutTextPath,
  domainHits: finalLayoutDomainHits,
  routeHits: finalLayoutRouteHits,
  syntheticHits: finalLayoutSyntheticHits,
  forbiddenActionHits: finalLayoutForbiddenActionHits,
  blockingHits: finalLayoutBlockingHits,
  ok: finalLayoutDomainHits.length > 0 &&
    finalLayoutSyntheticHits.length === 0 &&
    finalLayoutForbiddenActionHits.length === 0 &&
    finalLayoutBlockingHits.length === 0
};
const processCleanup = {
  activeHilogProcesses: hilogProcesses,
  ok: hilogProcesses.length === 0
};

const summaryPath = join(outDir, 'summary.json');
writeFileSync(summaryPath, JSON.stringify({ target, timeoutMs, summaries, visibleOutput, processCleanup }, null, 2));
console.log(`\nsummary: ${summaryPath}`);
console.log(`visibleOutput: ${JSON.stringify(visibleOutput, null, 2)}`);
console.log(`processCleanup: ${JSON.stringify(processCleanup, null, 2)}`);
const failed = summaries.filter((summary) => !summary.ok);
process.exitCode = failed.length === 0 && visibleOutput.ok && processCleanup.ok ? 0 : 1;
