import fs from "node:fs";
import vm from "node:vm";

for (const name of ["LINE_TOKEN", "LINE_USER_ID"]) {
  if (!process.env[name]) throw new Error(`缺少 GitHub Secret：${name}`);
}
if (!/^U[0-9a-f]{32}$/i.test(process.env.LINE_USER_ID)) {
  throw new Error("LINE_USER_ID 格式不正確，應為 U 開頭加 32 位十六進位字元。");
}

const truthy = value => /^(1|true|yes|on)$/i.test(String(value || ""));
const forceSend = truthy(process.env.FORCE_SEND);
const alwaysRemind = truthy(process.env.ALWAYS_REMIND);

async function readProgress() {
  for (const name of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SYNC_CODE"]) {
    if (!process.env[name]) throw new Error(`缺少 GitHub Secret：${name}`);
  }
  const base = process.env.SUPABASE_URL.replace(/\/+$/, "");
  const response = await fetch(`${base}/rest/v1/rpc/jp_pull`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({p_code: process.env.SYNC_CODE})
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}`);
  const rows = body ? JSON.parse(body) : [];
  const state = rows?.[0]?.data;
  if (!state || typeof state !== "object" || !state.cards) {
    throw new Error("同步碼找不到日文學習進度");
  }
  return state;
}

function appSummary(remoteState) {
  const html = fs.readFileSync(process.env.APP_FILE || "index.html", "utf8");
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/i);
  if (!scriptMatch) throw new Error("index.html 找不到日文學習程式");

  // 不執行瀏覽器初始化與同步，只載入卡庫和原本的排程函式。
  const script = scriptMatch[1].replace(/\/\* 首頁先同步畫出[\s\S]*$/, "");
  const emptyElement = () => ({
    innerHTML: "", value: "", textContent: "", dataset: {}, style: {},
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, focus() {}, select() {}, click() {}
  });
  const app = emptyElement(), nav = emptyElement();
  const document = {
    hidden: false, body: {appendChild() {}}, addEventListener() {},
    createElement: emptyElement,
    getElementById: id => id === "app" ? app : (id === "nav" ? nav : emptyElement())
  };
  const window = {
    speechSynthesis: null, storage: null, scrollY: 0,
    addEventListener() {}, scrollTo() {}
  };
  window.top = window.self = window;
  const context = vm.createContext({
    console, document, window, localStorage: null, navigator: {},
    alert() {}, confirm: () => true, fetch,
    setTimeout, clearTimeout, Date, Math, JSON, Blob, URL, crypto: globalThis.crypto
  });
  context.globalThis = context;
  vm.runInContext(script, context, {timeout: 5000});
  context.remoteState = remoteState;

  return JSON.parse(vm.runInContext(`JSON.stringify((()=>{
    S=Object.assign(S,remoteState);
    if(!S.cards)S.cards={};
    if(!S.done)S.done={};
    if(!S.task)S.task={};
    if(!S.reading)S.reading={};
    if(!S.output)S.output={correct:0,total:0};
    if(!S.off)S.off={vocab4:1,gram4:1,listen:1};
    S.newPerDay=NEW_CAP;
    if(![0,60,100,150,200].includes(S.reviewMax))S.reviewMax=100;
    if(typeof S.backlogProtect!=="number")S.backlogProtect=1;
    const t=today();
    if(!S.day||S.day.d!==t){
      if(S.last){const gap=dnum(t)-dnum(S.last);S.streak=gap===1?(S.streak||0)+1:(gap===0?(S.streak||0):0);}
      S.day={d:t,newN:0,revN:0,retryN:0};
    }
    if(typeof S.day.retryN!=="number")S.day.retryN=0;
    const q=buildQueue(),info=scheduleInfo();
    return {
      date:t,
      done:S.day.newN+S.day.revN+S.day.retryN,
      remaining:q.length,
      newRemaining:q.filter(c=>!seen(c.id)).length,
      retryRemaining:q.filter(c=>isRetry(c.id)).length,
      dueDemand:info.dueDemand,
      overflow:info.overflow,
      paused:info.paused,
      reviewMax:S.reviewMax,
      streak:S.streak||0
    };
  })())`, context, {timeout: 5000}));
}

function goalText(today) {
  const date = process.env.GOAL_DATE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return "";
  const from = new Date(`${today}T00:00:00+08:00`);
  const to = new Date(`${date}T00:00:00+08:00`);
  const days = Math.ceil((to - from) / 86400000);
  if (days < 0) return "";
  return `　離${process.env.GOAL_LABEL || "目標日"}還有 ${days} 天`;
}

function makeMessage(summary) {
  const link = process.env.APP_URL ? `\n\n開啟今日練習：${process.env.APP_URL}` : "";
  const status = `目前連續 ${summary.streak} 天${goalText(summary.date)}`;
  if (summary.remaining === 0) {
    return `今天的日文已經完成了 🎉\n\n${status}${link}`;
  }
  if (summary.paused) {
    return `到期複習有 ${summary.dueDemand} 張，超過每天 ${summary.reviewMax} 張上限，今天先不加新卡。\n\n今天做了 ${summary.done} 張，還剩 ${summary.remaining} 張。\n\n${status}${link}`;
  }
  if (summary.done === 0) {
    const fresh = summary.newRemaining ? `\n\n其中 ${summary.newRemaining} 張是新內容。` : "";
    return `今天的日文還沒開始，有 ${summary.remaining} 張等著。${fresh}\n\n${status}${link}`;
  }
  return `今天做了 ${summary.done} 張，還剩 ${summary.remaining} 張。\n\n${status}${link}`;
}

async function pushLine(text) {
  const response = await fetch(process.env.LINE_API_URL || "https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LINE_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({to: process.env.LINE_USER_ID, messages: [{type: "text", text}]})
  });
  const body = await response.text();
  if (!response.ok) {
    let detail = "";
    try { detail = JSON.parse(body).message || ""; } catch {}
    throw new Error(`LINE 推播失敗：HTTP ${response.status}${detail ? `，${detail}` : ""}`);
  }
}

let summary, message;
try {
  summary = appSummary(await readProgress());
  if (summary.remaining === 0 && !alwaysRemind && !forceSend) {
    console.log("今日學習已完成，不傳送提醒。");
    process.exit(0);
  }
  message = makeMessage(summary);
} catch (error) {
  console.warn(`無法讀取或計算進度：${error.message}`);
  message = "日文學習時間到了 🇯🇵\n今天完成一點，也是在累積進步。";
  if (process.env.APP_URL) message += `\n\n開啟今日練習：${process.env.APP_URL}`;
}

await pushLine(message);
console.log("LINE 日文學習提醒已送出。", summary || "使用簡單提醒");
