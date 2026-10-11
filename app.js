import "./env.js";
import process from "node:process";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { pool, withTransaction } from "./db.js";
import { createTransport } from "./mail.js";
import cors from "cors";

const allowedOrigins = (
  process.env.CORS_ORIGIN || "http://localhost:5173"
)
  .split(",")
  .map((origin) => origin.trim());

const app = express();
const COOKIE = "hyqual_session";
const TTL = 12 * 60 * 60 * 1000;
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(cors({
  origin(origin, callback) {
    // Allow requests without an Origin header, such as health checks.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Origin not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));


function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function roleName(role) { return ({ farm_owner: "Farm Owner", admin: "BFAR Admin", super_admin: "Superadmin" })[role] || role; }
function statusName(status) { return ({ active: "Active", disabled: "Inactive", suspended: "Suspended", pending: "Pending", rejected: "Rejected" })[status] || status; }
function makeUser(account, profile) {
  return { ...profile, id: String(account.account_id), uid: String(account.account_id),
    accountId: account.account_id, email: profile.email, username: account.username,
    role: roleName(account.role), status: statusName(account.status), archived: false };
}
function signSession(accountId, expiry) {
  const payload = `${accountId}.${expiry}`;
  const sig = crypto.createHmac("sha256", process.env.SESSION_SECRET || process.env.JWT_SECRET || "change-this-session-secret").update(payload).digest("hex");
  return `${payload}.${sig}`;
}
function readSession(token) {
  if (!token) return null;
  const [id, expiry, sig] = token.split(".");
  if (!id || !expiry || !sig || Number(expiry) < Date.now()) return null;
  const expected = crypto.createHmac("sha256", process.env.SESSION_SECRET || process.env.JWT_SECRET || "change-this-session-secret").update(`${id}.${expiry}`).digest("hex");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return Number(id);
}
async function requireAuth(req, res, next) {
  try {
    const id = readSession(req.cookies[COOKIE]);
    if (!id) throw httpError(401, "Authentication required.");
    const { rows } = await pool.query(`SELECT a.*, p.first_name, p.middle_name, p.last_name, p.email, p.phone
      FROM accounts a LEFT JOIN user_profiles p ON p.account_id=a.account_id WHERE a.account_id=?`, [id]);
    if (!rows[0]) throw httpError(401, "Authentication required.");
    const row = rows[0];
    if (row.status !== "active") throw httpError(403, row.status === "pending" ? "Your account is still pending approval." : "This account is not active.");
    req.account = row;
    req.user = makeUser(row, { firstName: row.first_name, middleName: row.middle_name, lastName: row.last_name, email: row.email, phone: row.phone, mobile: row.phone, role: roleName(row.role) });
    next();
  } catch (e) { next(e); }
}
function requireSuperadmin(req, res, next) {
  if (req.account?.role !== "super_admin") return next(httpError(403, "Superadmin access is required."));
  next();
}
function normalizeEmail(value) {
  if (typeof value !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw httpError(400, "A valid email address is required.");
  return value.trim().toLowerCase();
}
function camelProfile(row) {
  return { firstName: row.first_name, middleName: row.middle_name, lastName: row.last_name, email: row.email, phone: row.phone };
}
async function audit(accountId, type, description) {
  await pool.query("INSERT INTO activity_logs (account_id, action_type, action_description) VALUES (?, ?, ?)", [accountId, type, description || null]);
}
const loginLimiter = rateLimit({ windowMs: 15*60*1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });
const resetLimiter = rateLimit({ windowMs: 60*60*1000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false });

app.get("/api/health", async (_req,res,next)=>{ try { await pool.query("SELECT 1"); res.json({status:"ok"}); } catch(e){next(e);} });

app.post("/api/auth/login", loginLimiter, async (req,res,next)=>{
  try {
    const identifier = String(req.body.email || req.body.username || "").trim().toLowerCase();
    const {rows}=await pool.query(`SELECT a.*, p.first_name,p.middle_name,p.last_name,p.email,p.phone
      FROM accounts a LEFT JOIN user_profiles p ON p.account_id=a.account_id
      WHERE LOWER(a.username)=? OR LOWER(p.email)=? LIMIT 1`,[identifier,identifier]);
    const row=rows[0];
    if(!row?.password_hash || !(await bcrypt.compare(req.body.password || "",row.password_hash))) throw httpError(401,"Invalid username/email or password.");
    if(row.status!=="active") throw httpError(403,row.status==="pending"?"Your account is still pending approval.":"This account is not active.");
    await audit(row.account_id,"login","Signed in to HyQual website.");
    res.cookie(COOKIE,signSession(row.account_id,Date.now()+TTL),{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",maxAge:TTL});
    res.json({user:makeUser(row,camelProfile(row))});
  }catch(e){next(e);}
});
app.get("/api/auth/me",requireAuth,(req,res)=>res.json({user:req.user}));
app.post("/api/auth/logout",async(req,res)=>{res.clearCookie(COOKIE,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/"});res.status(204).end();});
app.post("/api/auth/register",async(req,res,next)=>{
  try {
    const username=String(req.body.username||req.body.email||"").trim().toLowerCase();
    const email=normalizeEmail(req.body.email);
    if(!username) throw httpError(400,"Username is required.");
    if(typeof req.body.password!=="string"||req.body.password.length<6) throw httpError(400,"Password must be at least 6 characters long.");
    const result=await withTransaction(async c=>{
      const a=await c.query("INSERT INTO accounts (username,password_hash,role,status) VALUES (?,?, 'farm_owner','pending')",[username,await bcrypt.hash(req.body.password,10)]);
      await c.query(`INSERT INTO user_profiles (account_id,first_name,middle_name,last_name,email,phone) VALUES (?,?,?,?,?,?)`,
        [a.insertId,req.body.firstName||"Pending",req.body.middleName||null,req.body.lastName||"User",email,req.body.phone||req.body.mobile||null]);
      return a.insertId;
    });
    res.status(201).json({id:String(result),status:"Pending"});
  }catch(e){next(e);}
});
app.post("/api/auth/password",requireAuth,async(req,res,next)=>{
  try {
    const {rows}=await pool.query("SELECT password_hash FROM accounts WHERE account_id=?",[req.account.account_id]);
    if(!(await bcrypt.compare(req.body.currentPassword||"",rows[0].password_hash))) throw httpError(400,"Current password is incorrect.");
    if(typeof req.body.newPassword!=="string"||req.body.newPassword.length<6) throw httpError(400,"New password must be at least 6 characters.");
    await pool.query("UPDATE accounts SET password_hash=? WHERE account_id=?",[await bcrypt.hash(req.body.newPassword,10),req.account.account_id]);
    res.status(204).end();
  }catch(e){next(e);}
});
app.post("/api/auth/forgot-password",resetLimiter,async(req,res,next)=>{
  try{
    const email=normalizeEmail(req.body.email);
    const {rows}=await pool.query("SELECT a.account_id,p.email FROM accounts a JOIN user_profiles p ON p.account_id=a.account_id WHERE LOWER(p.email)=?",[email]);
    if(rows[0]){
      const token=crypto.randomBytes(32).toString("hex");
      await pool.query("INSERT INTO password_resets (account_id,token,expires_at) VALUES (?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR))",[rows[0].account_id,token]);
      if(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM) {
        const { transport, from } = createTransport();
        await transport.sendMail({ from, to: email, subject: "HyQual password reset", text: `Use this reset token in HyQual: ${token}\nThis token expires in one hour.` });
      }
      if(process.env.NODE_ENV!=="production") res.json({message:"If the account exists, reset instructions have been prepared.",...(process.env.EXPOSE_RESET_TOKEN==="true"?{token}:{})});
      else res.json({message:"If the account exists, reset instructions have been sent."});
    }else res.json({message:"If the account exists, reset instructions have been sent."});
  }catch(e){next(e);}
});
app.post("/api/auth/reset-password",async(req,res,next)=>{
 try{
   const {token,password}=req.body;
   if(typeof password!=="string"||password.length<6) throw httpError(400,"Password must be at least 6 characters.");
   const {rows}=await pool.query("SELECT reset_id,account_id FROM password_resets WHERE token=? AND used=0 AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1",[token]);
   if(!rows[0]) throw httpError(400,"This reset link is invalid or expired.");
   await withTransaction(async c=>{await c.query("UPDATE accounts SET password_hash=? WHERE account_id=?",[await bcrypt.hash(password,10),rows[0].account_id]);await c.query("UPDATE password_resets SET used=1 WHERE reset_id=?",[rows[0].reset_id]);});
   res.status(204).end();
 }catch(e){next(e);}
});

app.get("/api/users",requireAuth,requireSuperadmin,async(_req,res,next)=>{
 try{
  const {rows}=await pool.query(`SELECT a.*,p.first_name,p.middle_name,p.last_name,p.email,p.phone
    FROM accounts a LEFT JOIN user_profiles p ON p.account_id=a.account_id ORDER BY a.created_at DESC LIMIT 5000`);
  res.json(rows.map(r=>makeUser(r,camelProfile(r))));
 }catch(e){next(e);}
});
app.post("/api/users",requireAuth,requireSuperadmin,async(req,res,next)=>{
 try{
  const username=String(req.body.username||req.body.email||"").trim().toLowerCase(), email=normalizeEmail(req.body.email);
  if(!req.body.password||req.body.password.length<6) throw httpError(400,"Password must be at least 6 characters.");
  const role=({ "Superadmin":"super_admin","BFAR Admin":"admin","Farm Owner":"farm_owner",super_admin:"super_admin",admin:"admin",farm_owner:"farm_owner"})[req.body.role]||"farm_owner";
  const status=({Active:"active",Pending:"pending",Inactive:"disabled",Rejected:"rejected",active:"active",pending:"pending",disabled:"disabled",rejected:"rejected"})[req.body.status]||"active";
  const id=await withTransaction(async c=>{const a=await c.query("INSERT INTO accounts(username,password_hash,role,status) VALUES(?,?,?,?)",[username,await bcrypt.hash(req.body.password,10),role,status]);await c.query("INSERT INTO user_profiles(account_id,first_name,middle_name,last_name,email,phone) VALUES(?,?,?,?,?,?)",[a.insertId,req.body.firstName||"",req.body.middleName||null,req.body.lastName||"",email,req.body.phone||req.body.mobile||null]);return a.insertId;});
  res.status(201).json({id:String(id)});
 }catch(e){next(e);}
});
app.patch("/api/users/:id",requireAuth,async(req,res,next)=>{
 try{
  const id=Number(req.params.id);
  if(req.account.role!=="super_admin"&&id!==req.account.account_id) throw httpError(403,"You may only update your own profile.");
  if(req.account.role==="super_admin"){
   const map={Active:"active",Pending:"pending",Inactive:"disabled",Suspended:"suspended",Rejected:"rejected",active:"active",pending:"pending",disabled:"disabled",suspended:"suspended",rejected:"rejected"};
   if(req.body.status) await pool.query("UPDATE accounts SET status=? WHERE account_id=?",[map[req.body.status]||req.body.status,id]);
   if(req.body.role){const roles={"Farm Owner":"farm_owner","BFAR Admin":"admin","Superadmin":"super_admin"};await pool.query("UPDATE accounts SET role=? WHERE account_id=?",[roles[req.body.role]||req.body.role,id]);}
  }
  const fields={firstName:"first_name",middleName:"middle_name",lastName:"last_name",phone:"phone",mobile:"phone"};
  for(const [k,col] of Object.entries(fields)) if(req.body[k]!==undefined) await pool.query(`UPDATE user_profiles SET ${col}=? WHERE account_id=?`,[req.body[k]||null,id]);
  if(req.body.email!==undefined) await pool.query("UPDATE user_profiles SET email=? WHERE account_id=?",[normalizeEmail(req.body.email),id]);
  const {rows}=await pool.query("SELECT a.*,p.first_name,p.middle_name,p.last_name,p.email,p.phone FROM accounts a LEFT JOIN user_profiles p ON p.account_id=a.account_id WHERE a.account_id=?",[id]);
  if(!rows[0]) throw httpError(404,"User not found.");
  res.json(makeUser(rows[0],camelProfile(rows[0])));
 }catch(e){next(e);}
});
app.delete("/api/users/:id",requireAuth,requireSuperadmin,async(req,res,next)=>{
 try{if(Number(req.params.id)===req.account.account_id) throw httpError(400,"You cannot delete your own account.");await pool.query("DELETE FROM accounts WHERE account_id=?",[Number(req.params.id)]);res.status(204).end();}catch(e){next(e);}
});
app.post("/api/approvals/:id/approve",requireAuth,requireSuperadmin,async(req,res,next)=>{try{await pool.query("UPDATE accounts SET status='active' WHERE account_id=? AND status='pending'",[Number(req.params.id)]);await audit(req.account.account_id,"account_approved",`Approved account ${req.params.id}`);res.status(204).end();}catch(e){next(e);}});
app.post("/api/approvals/:id/reject",requireAuth,requireSuperadmin,async(req,res,next)=>{try{await pool.query("UPDATE accounts SET status='rejected' WHERE account_id=? AND status='pending'",[Number(req.params.id)]);await audit(req.account.account_id,"account_rejected",`Rejected account ${req.params.id}`);res.status(204).end();}catch(e){next(e);}});

async function collectionData(name){
 if(name==="directory"||name==="approvals"){
  const where=name==="approvals"?"WHERE a.status IN ('pending','rejected')":"";
  const {rows}=await pool.query(`SELECT a.*,p.first_name,p.middle_name,p.last_name,p.email,p.phone FROM accounts a LEFT JOIN user_profiles p ON p.account_id=a.account_id ${where} ORDER BY a.created_at DESC LIMIT 5000`);
  return rows.map(r=>makeUser(r,camelProfile(r)));
 }
 if(name==="farms"){
  const {rows}=await pool.query(`SELECT f.*,a.account_id,a.username,p.first_name,p.last_name FROM aquaculture_farms f JOIN accounts a ON a.account_id=f.owner_id LEFT JOIN user_profiles p ON p.account_id=a.account_id ORDER BY f.farm_id`);
  return rows.map(r=>({id:String(r.farm_id),farmId:r.farm_id,farmName:r.farm_name,name:r.farm_name,ownerId:String(r.owner_id),owner:[r.first_name,r.last_name].filter(Boolean).join(" "),location:r.location||[r.street,r.barangay,r.municipality,r.province].filter(Boolean).join(", "),street:r.street,barangay:r.barangay,city:r.municipality,province:r.province,zip:r.zip_code,createdAt:r.created_at,updatedAt:r.updated_at}));
 }
 if(name==="ponds"){
  const {rows}=await pool.query(`SELECT p.*, (SELECT JSON_OBJECT('temperature',w.temperature,'phLevel',w.ph_level,'dissolvedOxygen',w.dissolved_oxygen,'salinity',w.salinity,'recordedAt',w.recorded_at) FROM water_quality_readings w WHERE w.pond_id=p.pond_id ORDER BY w.recorded_at DESC LIMIT 1) latest FROM ponds p ORDER BY p.pond_id`);
  return rows.map(r=>({id:String(r.pond_id),pondId:r.pond_id,farmId:String(r.farm_id),pondName:r.pond_name,name:r.pond_name,volume:r.volume,latestReading:typeof r.latest==="string"?JSON.parse(r.latest):r.latest}));
 }
 if(name==="devices"){
  const {rows}=await pool.query(`SELECT d.*,s.battery_percentage,s.is_charging,s.connectivity_status,s.signal_strength,s.active_sensors_count,s.recorded_at,s.last_seen_at FROM monitoring_devices d LEFT JOIN device_status s ON s.device_id=d.device_id ORDER BY d.device_id`);
  return rows.map(r=>({id:String(r.device_id),deviceId:r.device_id,farmId:String(r.farm_id),pondId:r.pond_id==null?null:String(r.pond_id),deviceName:r.device_name,name:r.device_name,status:r.status,installedAt:r.installed_at,deviceKey:r.device_key,batteryPercentage:r.battery_percentage,isCharging:!!r.is_charging,connectivityStatus:r.last_seen_at ? (Date.now()-new Date(r.last_seen_at).getTime()>5*60*1000?'offline':r.connectivity_status) : r.connectivity_status,signalStrength:r.signal_strength,activeSensorsCount:r.active_sensors_count,lastSeenAt:r.last_seen_at}));
 }
 if(name==="alerts"){
  const {rows}=await pool.query("SELECT * FROM early_warning_notifications ORDER BY created_at DESC LIMIT 5000");
  return rows.map(r=>({id:String(r.notification_id),notificationId:r.notification_id,farmId:String(r.farm_id),pondId:r.pond_id==null?null:String(r.pond_id),deviceId:r.device_id==null?null:String(r.device_id),parameter:r.parameter,title:r.title,alertLevel:r.alert_level,status:r.alert_level,alertMessage:r.alert_message,message:r.alert_message,recommendedAction:r.recommended_action,estimatedArrivalTime:r.estimated_arrival_time,isResolved:!!r.is_resolved,isRead:!!r.is_read,createdAt:r.created_at}));
 }
 if(name==="auditLogs"){
  const {rows}=await pool.query("SELECT l.*,a.username,p.first_name,p.last_name FROM activity_logs l JOIN accounts a ON a.account_id=l.account_id LEFT JOIN user_profiles p ON p.account_id=a.account_id ORDER BY l.logged_at DESC LIMIT 5000");
  return rows.map(r=>({id:String(r.log_id),actorId:String(r.account_id),actor:[r.first_name,r.last_name].filter(Boolean).join(" ")||r.username,actorRole:"",type:r.action_type,action:r.action_type,detail:r.action_description,createdAt:r.logged_at}));
 }
 throw httpError(404,"Collection not found.");
}
app.get("/api/collections/:collection",requireAuth,async(req,res,next)=>{
 try{
  const name=req.params.collection;
  if(!["farms","ponds","devices","alerts","approvals","auditLogs","directory"].includes(name)) throw httpError(404,"Collection not found.");
  if(["approvals","auditLogs"].includes(name)&&req.account.role!=="super_admin") throw httpError(403,"Superadmin access is required.");
  res.json(await collectionData(name));
 }catch(e){next(e);}
});
app.post("/api/collections/:collection",requireAuth,requireSuperadmin,async(req,res,next)=>{
 try{
  const n=req.params.collection,b=req.body;
  if(n==="farms"){
   const r=await pool.query("INSERT INTO aquaculture_farms(owner_id,farm_name,street,barangay,municipality,province,zip_code,location) VALUES(?,?,?,?,?,?,?,?)",[Number(b.ownerId),b.farmName||b.name||"New farm",b.street||null,b.barangay||null,b.city||b.municipality||null,b.province||null,b.zip||b.zipCode||null,b.location||null]);return res.status(201).json({id:String(r.insertId)});
  }
  if(n==="ponds"){
   const r=await pool.query("INSERT INTO ponds(farm_id,pond_name,volume) VALUES(?,?,?)",[Number(b.farmId),b.pondName||b.name||"New pond",b.volume??null]);return res.status(201).json({id:String(r.insertId)});
  }
  if(n==="devices"){
   const key=crypto.randomBytes(24).toString("hex");
   const r=await pool.query("INSERT INTO monitoring_devices(farm_id,pond_id,device_name,status,device_key) VALUES(?,?,?,?,?)",[Number(b.farmId),b.pondId?Number(b.pondId):null,b.deviceName||b.name||"New device",b.status||"active",key]);return res.status(201).json({id:String(r.insertId),deviceKey:key});
  }
  if(n==="alerts"){
   const r=await pool.query("INSERT INTO early_warning_notifications(farm_id,pond_id,device_id,parameter,title,alert_level,alert_message,recommended_action) VALUES(?,?,?,?,?,?,?,?)",[Number(b.farmId),b.pondId?Number(b.pondId):null,b.deviceId?Number(b.deviceId):null,b.parameter||null,b.title||"Notification",b.alertLevel||b.status||"low",b.alertMessage||b.message||"",b.recommendedAction||null]);return res.status(201).json({id:String(r.insertId)});
  }
  throw httpError(403,"This collection cannot be created through this API.");
 }catch(e){next(e);}
});
app.patch("/api/collections/:collection/:id",requireAuth,requireSuperadmin,async(req,res,next)=>{
 try{
  const n=req.params.collection,id=Number(req.params.id),b=req.body;
  if(n==="farms"){const fields={farmName:"farm_name",name:"farm_name",ownerId:"owner_id",street:"street",barangay:"barangay",city:"municipality",municipality:"municipality",province:"province",zip:"zip_code",location:"location"};for(const[k,col]of Object.entries(fields))if(b[k]!==undefined)await pool.query(`UPDATE aquaculture_farms SET ${col}=? WHERE farm_id=?`,[b[k],id]);}
  else if(n==="ponds"){if(b.pondName!==undefined||b.name!==undefined)await pool.query("UPDATE ponds SET pond_name=? WHERE pond_id=?",[b.pondName||b.name,id]);if(b.farmId!==undefined)await pool.query("UPDATE ponds SET farm_id=? WHERE pond_id=?",[Number(b.farmId),id]);if(b.volume!==undefined)await pool.query("UPDATE ponds SET volume=? WHERE pond_id=?",[b.volume,id]);}
  else if(n==="devices"){const fields={deviceName:"device_name",status:"status",farmId:"farm_id",pondId:"pond_id"};for(const[k,col]of Object.entries(fields))if(b[k]!==undefined)await pool.query(`UPDATE monitoring_devices SET ${col}=? WHERE device_id=?`,[b[k]===""?null:b[k],id]);}
  else if(n==="alerts"){const fields={title:"title",alertLevel:"alert_level",alertMessage:"alert_message",recommendedAction:"recommended_action",isResolved:"is_resolved",isRead:"is_read"};for(const[k,col]of Object.entries(fields))if(b[k]!==undefined)await pool.query(`UPDATE early_warning_notifications SET ${col}=? WHERE notification_id=?`,[b[k],id]);}
  else throw httpError(403,"This collection cannot be changed through this API.");
  res.json({id:String(id),...b});
 }catch(e){next(e);}
});
app.delete("/api/collections/:collection/:id",requireAuth,requireSuperadmin,async(req,res,next)=>{
 try{const table={farms:["aquaculture_farms","farm_id"],ponds:["ponds","pond_id"],devices:["monitoring_devices","device_id"],alerts:["early_warning_notifications","notification_id"]}[req.params.collection];if(!table)throw httpError(403,"This collection cannot be deleted through this API.");await pool.query(`DELETE FROM ${table[0]} WHERE ${table[1]}=?`,[Number(req.params.id)]);res.status(204).end();}catch(e){next(e);}
});
app.post("/api/audit-logs",requireAuth,async(req,res,next)=>{try{await audit(req.account.account_id,req.body.type||req.body.action||"activity",req.body.detail||req.body.action||"");res.status(204).end();}catch(e){next(e);}});
app.post("/api/presence/heartbeat",requireAuth,(_req,res)=>res.status(204).end());
app.get("/api/presence",requireAuth,requireSuperadmin,(_req,res)=>res.json([]));

app.post("/api/device/registrations",requireAuth,async(req,res,next)=>{
 try{
  const b=req.body;if(!b.farmId)throw httpError(400,"farmId is required.");
  const {rows}=await pool.query("SELECT farm_id FROM aquaculture_farms WHERE farm_id=?",[Number(b.farmId)]);if(!rows[0])throw httpError(400,"The selected farm does not exist.");
  const key=crypto.randomBytes(24).toString("hex");
  const r=await pool.query("INSERT INTO monitoring_devices(farm_id,pond_id,device_name,status,device_key) VALUES(?,?,?,?,?)",[Number(b.farmId),b.pondId?Number(b.pondId):null,b.deviceName||b.name||"Monitoring device","active",key]);
  res.status(201).json({id:String(r.insertId),deviceId:String(r.insertId),deviceKey:key});
 }catch(e){next(e);}
});
app.post("/api/devices/:deviceId/credentials",requireAuth,requireSuperadmin,async(req,res,next)=>{
 try{const id=Number(req.params.deviceId);const token=crypto.randomBytes(32).toString("base64url");await pool.query("UPDATE monitoring_devices SET device_key=? WHERE device_id=?",[token,id]);const {rows}=await pool.query("SELECT device_id FROM monitoring_devices WHERE device_id=?",[id]);if(!rows[0])throw httpError(404,"Device not found.");res.status(201).json({deviceId:String(id),token});}catch(e){next(e);}
});
app.delete("/api/devices/:deviceId/credentials",requireAuth,requireSuperadmin,async(req,res,next)=>{try{await pool.query("UPDATE monitoring_devices SET device_key=NULL WHERE device_id=?",[Number(req.params.deviceId)]);res.status(204).end();}catch(e){next(e);}});
async function requireDevice(req,res,next){try{const id=Number(req.get("x-device-id"));const key=req.get("x-device-token")||"";const {rows}=await pool.query("SELECT device_id,device_key,pond_id FROM monitoring_devices WHERE device_id=? AND status='active'",[id]);if(!rows[0]||!rows[0].device_key||rows[0].device_key!==key)throw httpError(401,"Device credentials are invalid or revoked.");req.device=rows[0];next();}catch(e){next(e);}}
app.post("/api/device/state",requireDevice,async(req,res,next)=>{
 try{const b=req.body;const allowed=["battery","status","assignment"];if(!allowed.includes(b.stateKey)||b.value===undefined)throw httpError(400,"A supported stateKey and value are required.");
  if(b.stateKey==="assignment"){const pondId=Number(b.value?.pondId??b.value);await pool.query("UPDATE monitoring_devices SET pond_id=? WHERE device_id=?",[pondId||null,req.device.device_id]);}
  if(b.stateKey==="battery"){await pool.query(`INSERT INTO device_status(device_id,battery_percentage,last_seen_at,recorded_at) VALUES(?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE battery_percentage=VALUES(battery_percentage),last_seen_at=NOW(),recorded_at=NOW()`,[req.device.device_id,Number(b.value)]);}
  if(b.stateKey==="status"){const val=typeof b.value==="string"?b.value:b.value.status;const status=["online","offline","weak"].includes(val)?val:"online";await pool.query(`INSERT INTO device_status(device_id,connectivity_status,last_seen_at,recorded_at) VALUES(?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE connectivity_status=VALUES(connectivity_status),last_seen_at=NOW(),recorded_at=NOW()`,[req.device.device_id,status]);}
  res.status(204).end();
 }catch(e){next(e);}
});
app.get("/api/device/state/:stateKey",requireAuth,async(req,res,next)=>{
 try{const {rows}=await pool.query("SELECT d.device_id,d.pond_id,s.battery_percentage,s.connectivity_status,s.signal_strength,s.active_sensors_count,s.last_seen_at FROM monitoring_devices d LEFT JOIN device_status s ON s.device_id=d.device_id WHERE d.device_id=?",[Number(req.query.deviceId||1)]);if(!rows[0])return res.json(null);const r=rows[0];const key=req.params.stateKey;res.json(key==="assignment"?{pondId:r.pond_id}:key==="battery"?r.battery_percentage:key==="status"?{status:r.connectivity_status,signalStrength:r.signal_strength,activeSensorsCount:r.active_sensors_count,lastSeenAt:r.last_seen_at}:null);}catch(e){next(e);}
});
app.post("/api/device/readings",requireDevice,async(req,res,next)=>{
 try{
  const b=req.body, list=Array.isArray(b.readings)?b.readings:[b];if(!list.length||list.length>500)throw httpError(400,"Submit between 1 and 500 readings per request.");
  const {rows:dev}=await pool.query("SELECT pond_id,farm_id FROM monitoring_devices WHERE device_id=?",[req.device.device_id]);if(!dev[0]||!dev[0].pond_id)throw httpError(400,"Assign this device to a pond before uploading readings.");
  const convert={temperature:"temperature",ph:"ph_level",do:"dissolved_oxygen",dissolved_oxygen:"dissolved_oxygen",salinity:"salinity",ec:"salinity"};
  await withTransaction(async c=>{for(const r of list){
   const p=convert[r.parameter];const val=Number(r.value);if(!p||!Number.isFinite(val))throw httpError(400,"Each reading requires a supported parameter and numeric value.");
   const columns={temperature:"temperature",ph_level:"ph_level",dissolved_oxygen:"dissolved_oxygen",salinity:"salinity"};
   const data={temperature:null,ph_level:null,dissolved_oxygen:null,salinity:null};data[p]=val;
   const date=r.createdAt?new Date(r.createdAt):new Date();if(Number.isNaN(date.getTime()))throw httpError(400,"Invalid reading timestamp.");
   await c.query("INSERT INTO water_quality_readings(device_id,pond_id,temperature,ph_level,dissolved_oxygen,salinity,recorded_at) VALUES(?,?,?,?,?,?,?)",[req.device.device_id,dev[0].pond_id,data.temperature,data.ph_level,data.dissolved_oxygen,data.salinity,date]);
   await c.query(`INSERT INTO device_status(device_id,connectivity_status,active_sensors_count,last_seen_at,recorded_at) VALUES(?,'online',4,NOW(),NOW()) ON DUPLICATE KEY UPDATE connectivity_status='online',last_seen_at=NOW(),recorded_at=NOW()`,[req.device.device_id]);
  }});
  res.status(201).json({inserted:list.length});
 }catch(e){next(e);}
});
app.get("/api/device/readings/:parameter",requireAuth,async(req,res,next)=>{
 try{const col=({temperature:"temperature",ph:"ph_level",do:"dissolved_oxygen",dissolved_oxygen:"dissolved_oxygen",salinity:"salinity",ec:"salinity"})[req.params.parameter];if(!col)throw httpError(400,"Unsupported reading parameter.");const limit=Math.max(1,Math.min(5000,Number(req.query.limit)||2000));const {rows}=await pool.query(`SELECT reading_id,device_id,pond_id,${col} AS value,recorded_at FROM water_quality_readings WHERE ${col} IS NOT NULL ORDER BY recorded_at DESC LIMIT ${limit}`);res.json(rows.reverse().map(r=>({id:r.reading_id,deviceId:r.device_id,pondId:r.pond_id,parameter:req.params.parameter,value:Number(r.value),createdAt:new Date(r.recorded_at).toISOString()})));}catch(e){next(e);}
});
app.use("/api",(req,res,next)=>next(httpError(404,"API route not found.")));
app.use((err,_req,res,_next)=>{if(err.code==="ER_DUP_ENTRY")return res.status(409).json({error:"A record with that username, email, or key already exists."});console.error(err);res.status(err.status||500).json({error:err.status?err.message:"Internal server error."});});
export default app;
