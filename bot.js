/* ====== chanddari-bot — FULL LOGIC (PocketBase-driven) ======
 * Node 18+ (Render: Node 22) — uses node-fetch v2 (require)
 * Reads ALL texts, UI, plans, config from PocketBase (live).
 * Env required: POCKETBASE_URL, PB_ADMIN_EMAIL, PB_ADMIN_PASSWORD
 * Webhook: https://<your-bot-service>.onrender.com/webhook
 */
const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// -------- ENV
const PB_URL = process.env.POCKETBASE_URL;
const PB_ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const PB_ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;

// -------- Admin token cache
let PB_ADMIN_TOKEN = null;
async function pbAdminLogin() {
  if (PB_ADMIN_TOKEN) return PB_ADMIN_TOKEN;
  const r = await fetch(`${PB_URL}/api/admins/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: PB_ADMIN_EMAIL, password: PB_ADMIN_PASSWORD })
  });
  if (!r.ok) throw new Error("PB admin login failed");
  const j = await r.json();
  PB_ADMIN_TOKEN = j.token;
  return PB_ADMIN_TOKEN;
}

// -------- tiny cache (TTL 300s) for read-mostly collections
const cache = new Map();
function putCache(k, v, ttl=300000){ cache.set(k, {v,exp:Date.now()+ttl}); }
function getCache(k){ const e=cache.get(k); if(!e) return null; if(Date.now()>e.exp){cache.delete(k); return null;} return e.v; }

// -------- PB helpers (public GET; admin GET/POST/PATCH)
async function pbGet(coll, params = "") {
  const key = `GET:${coll}:${params}`;
  const hit = getCache(key);
  if (hit) return hit;

  const url = `${PB_URL}/api/collections/${coll}/records${params ? "?" + params : ""}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`PB GET ${coll} ${r.status}`);
  const j = await r.json();
  putCache(key, j);
  return j;
}
async function pbAuthed(method, coll, body, id=null){
  const token = await pbAdminLogin();
  const url = `${PB_URL}/api/collections/${coll}/records${id?"/"+id:""}`;
  const r = await fetch(url, {
    method,
    headers: {
      "Content-Type":"application/json",
      "Authorization": `AdminAuth ${token}`
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if(!r.ok){
    const t = await r.text().catch(()=> "");
    throw new Error(`PB ${method} ${coll} -> ${r.status} ${t}`);
  }
  // invalidate read cache of that coll
  for (const k of [...cache.keys()]) if (k.startsWith(`GET:${coll}:`)) cache.delete(k);
  return r.json();
}

// -------- Config & content
async function configVal(key){
  const j = await pbGet("config", `perPage=1&filter=${encodeURIComponent(`(key="${key}")`)}`);
  return j.items?.[0]?.value ?? "";
}
async function msg(key){
  const j = await pbGet("messages", `perPage=1&filter=${encodeURIComponent(`(key="${key}")`)}`);
  return j.items?.[0]?.text ?? "";
}
async function uiMap(){
  const j = await pbGet("ui", "perPage=200&sort=key");
  const m = {}; (j.items||[]).forEach(it=> m[it.key]=it.value);
  return m;
}
async function provincesList(){
  const j = await pbGet("provinces", "perPage=100&sort=name");
  return (j.items||[]).map(x=>x.name);
}
async function plans(category, type){
  // category: "first" | "renew" ; type: "Trial"|"Mobile"|"Laptop"|"Vip"
  const filter = `(category="${category}" && active=true && plan_type="${type}")`;
  const j = await pbGet(category==="first"?"plans_first":"plans_renew", `perPage=50&sort=months&filter=${encodeURIComponent(filter)}`);
  return j.items || [];
}

// -------- Telegram helpers (token from PB config)
async function tg(method, payload){
  const token = await configVal("telegram_token");
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const r = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  if(!r.ok){ const t=await r.text().catch(()=> ""); console.error("TG", method, r.status, t); }
  return r.json().catch(()=> ({}));
}
const sendText = (chat_id, text, reply_markup=null) => tg("sendMessage", { chat_id, text, reply_markup });
async function getFileUrl(fileId){
  const token = await configVal("telegram_token");
  const g = await tg("getFile", { file_id: fileId });
  const path = g?.result?.file_path;
  return path ? `https://api.telegram.org/file/bot${token}/${path}` : null;
}

// -------- Order counter & IDs
async function nextCounter(){
  // counters: key="order", value (number-like)
  const found = await pbGet("counters", `perPage=1&filter=${encodeURIComponent(`(key="order")`)}`);
  let id = found.items?.[0]?.id || null;
  let val = Number(found.items?.[0]?.value ?? (await configVal("order_counter_start") || 1000));
  val += 1;
  if(id){
    await pbAuthed("PATCH", "counters", { value: String(val) }, id);
  } else {
    await pbAuthed("POST", "counters", { key:"order", value: String(val) });
  }
  return val;
}
async function makeOrderId(prefix){ // prefix T/N/R
  const num = await nextCounter();
  return `CD-${prefix}-${num}`;
}

// -------- Date helpers
function todayYMD(d=new Date()){ return d.toISOString().slice(0,10); }
function plusDaysYMD(days){
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}

// -------- Simple in-memory state machine (per chat)
const ST = {}; // chat_id -> { step, data, pendingRegId, flow } ; flow: "first" | "renew"
const setStep = (id, step)=>{ ST[id] = ST[id] || { data:{} }; ST[id].step = step; };
const getStep = (id)=> ST[id]?.step || null;
const dataOf = (id)=> (ST[id]||(ST[id]={data:{}})).data;
const setPending = (id, regId)=>{ ST[id] = ST[id]||{data:{}}; ST[id].pendingRegId = regId; };
const getPending = (id)=> ST[id]?.pendingRegId || null;
const setFlow = (id, flow)=>{ ST[id] = ST[id]||{data:{}}; ST[id].flow = flow; };
const getFlow = (id)=> ST[id]?.flow || "first";
const clearState = (id)=> { delete ST[id]; };

// -------- Keyboards
async function mainMenu(){
  const ui = await uiMap();
  return {
    keyboard: [
      [ui.label_start || "📝 شروع ثبت‌نام"],
      [ui.label_info || "ℹ️ اطلاعات کاربری من", ui.label_status || "🔐 وضعیت اشتراک من"],
      [ui.label_about || "📖 معرفی محصول"],
      [ui.label_channel || "📣 عضویت در کانال", ui.label_support || "🆘 ارتباط با پشتیبانی"],
      [(ui.label_renew || "🔄 تمدید اشتراک")]
    ],
    resize_keyboard: true
  };
}
async function stepBackMenu(){
  const ui = await uiMap();
  return {
    inline_keyboard: [
      [{ text: ui.label_back_step || "↩️ بازگشت به مرحله قبل", callback_data:"back_step" }],
      [{ text: ui.label_back_main || "🏠 بازگشت به منوی اصلی",  callback_data:"back_main" }]
    ]
  };
}

// -------- Helpers: trial once check
async function trialUsed(chat_id){
  const j = await pbGet("registrations", `perPage=1&filter=${encodeURIComponent(`(chat_id=${chat_id} && order_id~"CD-T-")`)}`);
  return (j.items||[]).length>0;
}

// -------- Registration upsert
async function createRegistration(chat_id, d, plan, category, order_id, status, receipt_status){
  // registrations fields spec:
  // ['timestamp','chat_id','full_name','company','phone','province','email',
  //  'plan_key','plan_label','status','start_date','end_date','days_left',
  //  'receipt_url','amount','notify5d','last_update','order_id','paid_count','receipt_status']
  // paid_count: count of paid orders before +1 (trial = 0)
  let paidCount = 0;
  if(plan.plan_type !== "Trial"){
    const paidBefore = await pbGet("registrations", `perPage=1&filter=${encodeURIComponent(`(chat_id=${chat_id} && order_id~"CD-N-" || order_id~"CD-R-")`)}`);
    paidCount = (paidBefore.items||[]).length + 1;
  }
  const now = new Date().toISOString();
  const start_date = status==="active" ? todayYMD() : "";
  const end_date   = status==="active" ? plusDaysYMD(Number(plan.days||0)) : "";
  const days_left  = status==="active" ? Number(plan.days||0) : 0;

  const body = {
    timestamp: now,
    chat_id,
    full_name: d.full_name || "",
    company: d.company || "",
    phone: d.phone || "",
    province: d.province || "",
    email: d.email || "",
    plan_key: plan.key,
    plan_label: plan.label,
    status,
    start_date,
    end_date,
    days_left,
    receipt_url: "",
    amount: Number(plan.price||0),
    notify5d: "",
    last_update: now,
    order_id,
    paid_count: paidCount,
    receipt_status
  };
  const rec = await pbAuthed("POST", "registrations", body);
  return rec;
}

// -------- CRON-like endpoint to update days_left & warnings
app.get("/cron/daily", async (_req, res)=>{
  try{
    const warnDays = 5;
    const autoDeactivate = (await configVal("auto_deactivate_on_zero_days")) === "Y";

    // fetch active subs
    const active = await pbGet("registrations", `perPage=200&filter=${encodeURIComponent(`(status="active")`)}`);
    const items = active.items || [];
    for (const r of items){
      if(!r.end_date) continue;
      const now = new Date();
      const end = new Date(r.end_date+"T00:00:00Z");
      const daysLeft = Math.ceil((end - now)/(24*3600*1000));
      let patch = {};
      if (r.days_left !== daysLeft){ patch.days_left = daysLeft; }
      if (daysLeft === warnDays && r.notify5d!=="Y"){
        const txt = (await msg("expire_warning_template"))
          .replace("{full_name}", r.full_name||"")
          .replace("{plan_label}", r.plan_label||"")
          .replace("{warn_days_left}", String(warnDays));
        await sendText(r.chat_id, txt);
        patch.notify5d = "Y";
      }
      if (daysLeft <= 0 && autoDeactivate){
        patch.status = "expired";
        await sendText(r.chat_id, await msg("auto_deactivated_on_zero"));
      }
      if (Object.keys(patch).length){
        patch.last_update = new Date().toISOString();
        await pbAuthed("PATCH", "registrations", patch, r.id);
      }
    }
    res.status(200).send("OK");
  }catch(e){ console.error("/cron/daily", e.message); res.status(500).send("ERR"); }
});

// -------- Webhook
app.get("/", (_q,res)=>res.status(200).send("OK"));

app.post("/webhook", async (req, res)=>{
  res.sendStatus(200); // ACK فوری
  try{
    const update = req.body;

    // -- callback_query: back buttons, plan choices, admin decisions
    if (update.callback_query){
      const cq = update.callback_query;
      const data = cq.data || "";
      const chatId = cq.message?.chat?.id;

      // back_main
      if (data==="back_main" && chatId){
        clearState(chatId);
        await sendText(chatId, "منوی اصلی:", await mainMenu());
        return;
      }
      // back_step (ساده: برگرد به مرحله قبل بر اساس جدول)
      if (data==="back_step" && chatId){
        const order = ["NAME","COMPANY","PHONE","PROVINCE","EMAIL","PLAN","RECEIPT"];
        const cur = getStep(chatId);
        const idx = Math.max(0, order.indexOf(cur)-1);
        const prev = order[idx] || "NAME";
        setStep(chatId, prev);
        if (prev==="NAME")       return sendText(chatId, await msg("ask_fullname"), await stepBackMenu());
        if (prev==="COMPANY")    return sendText(chatId, await msg("ask_company"), await stepBackMenu());
        if (prev==="PHONE")      return sendText(chatId, await msg("ask_phone"), await stepBackMenu());
        if (prev==="PROVINCE")   return sendText(chatId, await msg("ask_province"), { keyboard: (await provincesList()).map(p=>[{text:p}]), resize_keyboard:true });
        if (prev==="EMAIL")      return sendText(chatId, await msg("ask_email"), await stepBackMenu());
        if (prev==="PLAN")       return sendText(chatId, await msg("ask_plan"), await stepBackMenu());
        return;
      }

      // plan category: cat:<category>:<type>  => category in {first|renew}, type in {Trial|Mobile|Laptop|Vip}
      if (data.startsWith("cat:")){
        const [, category, type] = data.split(":");
        const chatId = cq.message.chat.id;

        // Trial eligibility (once)
        if (type==="Trial"){
          const allow = (await configVal("trial_allowed_once")) === "Y";
          const used  = await trialUsed(chatId);
          if (!allow || used){
            await sendText(chatId, await msg("trial_blocked"));
            return;
          }
        }

        const list = await plans(category, type);
        if (!list.length){
          await sendText(chatId, "فعلاً پلنی در این دسته فعال نیست.");
          return;
        }
        // build buttons with real IDs
        const rows = list.map(p=> [{ text: p.label || `${p.months} ماهه — ${p.price}`, callback_data: `plan:${category}:${p.id}` }]);
        rows.push([{ text: (await uiMap()).label_back_main || "🏠 بازگشت به منوی اصلی", callback_data:"back_main" }]);
        await sendText(chatId, `گزینه‌های «${type}»`, { inline_keyboard: rows });
        return;
      }

      // chosen plan: plan:<category>:<planId>
      if (data.startsWith("plan:")){
        const [, category, planId] = data.split(":");
        const chatId = cq.message.chat.id;
        const d = dataOf(chatId);
        const plColl = category==="first" ? "plans_first" : "plans_renew";
        const plan = (await pbGet(plColl, `perPage=1&filter=${encodeURIComponent(`(id="${planId}")`)}`)).items?.[0];
        if (!plan){ await sendText(chatId, "پلن پیدا نشد!"); return; }

        // decide order prefix and statuses
        if (plan.plan_type==="Trial"){
          // guard again
          const allow = (await configVal("trial_allowed_once")) === "Y";
          const used  = await trialUsed(chatId);
          if (!allow || used){ await sendText(chatId, await msg("trial_blocked")); return; }

          const order_id = await makeOrderId("T");
          const rec = await createRegistration(chatId, d, plan, category, order_id, "active", "Successful");
          await sendText(chatId, await msg("trial_success"), await mainMenu());
          clearState(chatId);
        } else {
          const prefix = (category==="renew") ? "R" : "N";
          const order_id = await makeOrderId(prefix);
          const rec = await createRegistration(chatId, d, plan, category, order_id, "pending", "Pending");

          const payTmpl = await msg("pay_msg");
          const text = payTmpl
            .replace("{full_name}", d.full_name||"")
            .replace("{plan_label}", plan.label||"")
            .replace("{order_id}", order_id)
            .replace("{date}", new Date().toLocaleDateString("fa-IR"))
            .replace("{time}", new Date().toLocaleTimeString("fa-IR"))
            .replace("{price}", String(plan.price||""))
            .replace("{card_number}", await configVal("card_number"))
            .replace("{card_name}", await configVal("card_name"));
          await sendText(chatId, text);
          await sendText(chatId, "لطفاً فیش واریزی را به صورت تصویر/فایل ارسال کنید.", await stepBackMenu());
          setStep(chatId, "RECEIPT");
          setPending(chatId, rec.id);
        }
        return;
      }

      // admin actions: admin_approve:<regId> | admin_reject:<regId>
      if (data.startsWith("admin_")){
        const [, action, regId] = data.split(":");
        const rec = (await pbGet("registrations", `perPage=1&filter=${encodeURIComponent(`(id="${regId}")`)}`)).items?.[0];
        if (!rec) return;

        if (action==="approve"){
          const days = Number(rec.days_left || 0) ||  ( // fallback: derive from plan label (not reliable) — better keep from plan.days at creation
            0
          );
          const patch = {
            receipt_status:"Successful",
            status:"active",
            start_date: todayYMD(),
            end_date: days ? plusDaysYMD(days) : (rec.end_date || plusDaysYMD(30)),
            days_left: days || rec.days_left || 30,
            last_update: new Date().toISOString()
          };
          await pbAuthed("PATCH", "registrations", patch, regId);
          await tg("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: `✅ تایید شد — ${new Date().toLocaleString("fa-IR")}` });
          await sendText(rec.chat_id, await msg("receipt_verified_user"));
        } else {
          await pbAuthed("PATCH", "registrations", { receipt_status:"Failed", status:"pending", last_update:new Date().toISOString() }, regId);
          await tg("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: `❌ رد شد — ${new Date().toLocaleString("fa-IR")}` });
          const sup = await configVal("support_username");
          await sendText(rec.chat_id, (await msg("receipt_rejected_user")).replace("{support_username}", sup||"@support"));
        }
        return;
      }

      return;
    }

    // -- messages
    const m = update.message;
    if (!m) return;
    const chatId = m.chat.id;
    const text = (m.text||"").trim();
    const step = getStep(chatId);

    // admin lists
    const adminGroupId = await configVal("admin_group_id");
    if (String(chatId) === String(adminGroupId) && text.startsWith("/")){
      if (text==="/pending"){
        const j = await pbGet("registrations", `perPage=50&sort=-timestamp&filter=${encodeURIComponent(`(receipt_status="Pending")`)}`);
        const lines = (j.items||[]).map(r=> `${r.full_name || ""} — ${r.order_id} — ${r.plan_label} — ${r.amount} — ${r.timestamp?.slice(0,16).replace("T"," ")}`);
        await sendText(chatId, lines.length? lines.join("\n") : "موردی نیست.");
      } else if (text==="/approved"){
        const j = await pbGet("registrations", `perPage=50&sort=-timestamp&filter=${encodeURIComponent(`(receipt_status="Successful")`)}`);
        const lines = (j.items||[]).map(r=> `${r.full_name || ""} — ${r.order_id} — ${r.plan_label}`);
        await sendText(chatId, lines.length? lines.join("\n") : "موردی نیست.");
      } else if (text==="/rejected"){
        const j = await pbGet("registrations", `perPage=50&sort=-timestamp&filter=${encodeURIComponent(`(receipt_status="Failed")`)}`);
        const lines = (j.items||[]).map(r=> `${r.full_name || ""} — ${r.order_id} — ${r.plan_label}`);
        await sendText(chatId, lines.length? lines.join("\n") : "موردی نیست.");
      }
      return;
    }

    // cancel
    if (["لغو","cancel","Cancel","/cancel"].includes(text)){
      clearState(chatId);
      await sendText(chatId, "فرآیند لغو شد. از منو ادامه بده.", await mainMenu());
      return;
    }

    // start
    if (text==="/start" || text===(await uiMap()).label_back_main){
      clearState(chatId);
      await sendText(chatId, await msg("welcome_start"), await mainMenu());
      return;
    }

    // about / channel / support
    if (text===(await uiMap()).label_about){
      await sendText(chatId, await msg("about_text"), await mainMenu()); return;
    }
    if (text===(await uiMap()).label_channel){
      await sendText(chatId, (await configVal("channel_url")) || ""); return;
    }
    if (text===(await uiMap()).label_support){
      await sendText(chatId, (await configVal("support_username")) || ""); return;
    }

    // profile/info
    if (text===(await uiMap()).label_info){
      // آخرین ثبت یا داده‌های state
      const last = (await pbGet("registrations", `perPage=1&sort=-timestamp&filter=${encodeURIComponent(`(chat_id=${chatId})`)}`)).items?.[0];
      if (!last){
        await sendText(chatId, await msg("profile_empty"), await mainMenu());
      } else {
        const lines = [
          `نام: ${last.full_name||""}`,
          `مجموعه: ${last.company||""}`,
          `تلفن: ${last.phone||""}`,
          `استان: ${last.province||""}`,
          `ایمیل: ${last.email||""}`
        ].join("\n");
        await sendText(chatId, lines, {
          inline_keyboard: [
            [{ text: (await uiMap()).label_edit_info || "✏️ ویرایش اطلاعات", callback_data:"edit_info" }],
            [{ text: (await uiMap()).label_back_main || "🏠 بازگشت به منوی اصلی", callback_data:"back_main" }]
          ]
        });
      }
      return;
    }

    // status
    if (text===(await uiMap()).label_status){
      const active = (await pbGet("registrations", `perPage=1&sort=-timestamp&filter=${encodeURIComponent(`(chat_id=${chatId} && status="active")`)}`)).items?.[0];
      if (!active){
        await sendText(chatId, await msg("no_active_subscription"));
      } else {
        const s = `پلن: ${active.plan_label}\nتا: ${active.end_date}\nمانده: ${active.days_left} روز`;
        await sendText(chatId, s);
      }
      return;
    }

    // renew flow
    if (text===(await uiMap()).label_renew || text==="🔄 تمدید اشتراک"){
      setFlow(chatId, "renew");
      setStep(chatId, "EMAIL"); // برای اطمینان ایمیل بگیریم
      await sendText(chatId, await msg("ask_email"), await stepBackMenu());
      return;
    }

    // start registration
    if (text===(await uiMap()).label_start || text==="📝 شروع ثبت‌نام"){
      setFlow(chatId, "first");
      setStep(chatId, "NAME");
      await sendText(chatId, await msg("ask_fullname"), await stepBackMenu());
      return;
    }

    // ====== STATE MACHINE ======
    const flow = getFlow(chatId); // first | renew

    if (getStep(chatId)==="NAME"){
      if (!text.includes(" ")) { await sendText(chatId, await msg("name_invalid"), await stepBackMenu()); return; }
      dataOf(chatId).full_name = text;
      setStep(chatId, "COMPANY");
      await sendText(chatId, await msg("ask_company"), await stepBackMenu());
      return;
    }
    if (getStep(chatId)==="COMPANY"){
      dataOf(chatId).company = text;
      setStep(chatId, "PHONE");
      await sendText(chatId, await msg("ask_phone"), await stepBackMenu());
      return;
    }
    if (getStep(chatId)==="PHONE"){
      if (!/^09\d{9}$/.test(text)) { await sendText(chatId, await msg("phone_invalid"), await stepBackMenu()); return; }
      dataOf(chatId).phone = text;
      setStep(chatId, "PROVINCE");
      await sendText(chatId, await msg("ask_province"), {
        keyboard: (await provincesList()).map(p=>[{text:p}]).concat([[{text:(await uiMap()).label_back_main || "🏠 بازگشت به منوی اصلی"}]]),
        resize_keyboard:true
      });
      return;
    }
    if (getStep(chatId)==="PROVINCE"){
      const pros = await provincesList();
      if (!pros.includes(text)){ await sendText(chatId, "⚠️ لطفاً از گزینه‌های زیر استفاده کنید.", { keyboard: pros.map(p=>[{text:p}]), resize_keyboard:true }); return; }
      dataOf(chatId).province = text;
      setStep(chatId, "EMAIL");
      await sendText(chatId, await msg("ask_email"), await stepBackMenu());
      return;
    }
    if (getStep(chatId)==="EMAIL"){
      if (!/^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(text)) { await sendText(chatId, await msg("email_invalid"), await stepBackMenu()); return; }
      dataOf(chatId).email = text;
      setStep(chatId, "PLAN");

      const ui = await uiMap();
      const allowTrial = (await configVal("trial_allowed_once"))==="Y";
      const usedTrial  = await trialUsed(chatId);
      const inline = [];

      // level-1 categories
      if (flow==="first"){
        if (allowTrial && !usedTrial) inline.push([{ text:"پلن تستی 3 روزه", callback_data:"cat:first:Trial" }]);
        inline.push([{ text:"پلن موبایل", callback_data:"cat:first:Mobile" }]);
        inline.push([{ text:"پلن لپتاپ", callback_data:"cat:first:Laptop" }]);
        inline.push([{ text:"پلن V.I.P", callback_data:"cat:first:Vip" }]);
      } else { // renew
        inline.push([{ text:"پلن موبایل", callback_data:"cat:renew:Mobile" }]);
        inline.push([{ text:"پلن لپتاپ", callback_data:"cat:renew:Laptop" }]);
        inline.push([{ text:"پلن V.I.P", callback_data:"cat:renew:Vip" }]);
      }
      inline.push([{ text: ui.label_back_main || "🏠 بازگشت به منوی اصلی", callback_data:"back_main" }]);

      await sendText(chatId, await msg("ask_plan"), { inline_keyboard: inline });
      return;
    }

    if (getStep(chatId)==="RECEIPT"){
      // دریافت فیش: Photo/Document/Text
      const photo = m.photo?.at(-1);
      const doc   = m.document;
      const textNote = m.text && !m.text.startsWith("/");
      let url = null;
      if (photo || doc){
        const fileId = (photo?.file_id || doc?.file_id);
        url = await getFileUrl(fileId);
      } else if (textNote){
        url = `TEXT:${text}`;
      } else {
        await sendText(chatId, await msg("receipt_invalid"));
        return;
      }

      const regId = getPending(chatId);
      await pbAuthed("PATCH", "registrations", { receipt_url: url, receipt_status:"Pending", last_update:new Date().toISOString() }, regId);
      await sendText(chatId, await msg("receipt_waiting"), await mainMenu());
      const adminId = await configVal("admin_group_id");
      const r = (await pbGet("registrations", `perPage=1&filter=${encodeURIComponent(`(id="${regId}")`)}`)).items?.[0];
      const notif = (await msg("admin_notify_new_receipt")).replace("{full_name}", r?.full_name||"");
      await tg("sendMessage", {
        chat_id: adminId,
        text: `${notif}\nOrder: ${r.order_id}\nPlan: ${r.plan_label}\nAmount: ${r.amount}\nUser: ${r.chat_id}\nReceipt: ${url?.slice(0,200)}`,
        reply_markup: { inline_keyboard: [[{text:"✅ تایید", callback_data:`admin_approve:${regId}`}, {text:"❌ رد", callback_data:`admin_reject:${regId}`}]] }
      });
      clearState(chatId);
      return;
    }

    // fallback
    await sendText(chatId, await msg("invalid_option"));

  }catch(e){
    console.error("WEBHOOK ERR:", e.message);
  }
});

// -------- Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("BOT running on", PORT));
