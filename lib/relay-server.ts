import {legacyWritesEnabled} from '@/server/agent-bridge';
import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '@/app/chatgpt-auth';
export type Workspace={id:string;owner_id:string;brand:string;greeting:string;color:string;availability:string};
export function database(){if(!env.DB)throw new Error('Chat storage is unavailable.');return env.DB;}
export class ApiError extends Error{constructor(message:string,public status=400){super(message);}}
export function response(data:unknown,status=200){return Response.json(data,{status,headers:{'Cache-Control':'no-store'}});}
export function failure(e:unknown){if(e instanceof ApiError)return response({error:e.message},e.status);console.error('Relay request failed',e instanceof Error?e.message:'Unknown error');return response({error:'We couldn’t save or load your conversation. Please try again.'},503);}
export async function body(request:Request){if(Number(request.headers.get('content-length'))>15000)throw new ApiError('That request is too long.',413);const raw=await request.text();if(raw.length>15000)throw new ApiError('That request is too long.',413);try{return JSON.parse(raw)}catch{throw new ApiError('Please send a valid request.');}}
export function sameOrigin(request:Request){const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)throw new ApiError('This request is not allowed.',403);}
export async function hash(token:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');}
export async function admin(){const user=await getChatGPTUser();if(!user)throw new ApiError('Sign in to open your inbox.',401);const db=database();let w=await db.prepare('SELECT * FROM workspace WHERE id = ?').bind('main').first<Workspace>();if(!w){if(!legacyWritesEnabled(env))throw new ApiError("Legacy inbox data is unavailable.",503);await seed(user.userId);w=await db.prepare('SELECT * FROM workspace WHERE id = ?').bind('main').first<Workspace>();}if(!w||w.owner_id!==user.userId)throw new ApiError('This inbox belongs to another workspace.',403);return {user,w,db};}
export function publicSettings(w:Workspace){return {brand:w.brand,greeting:w.greeting,color:w.color,availability:w.availability};}
async function seed(owner:string){const db=database();const now=Date.now();const items=[
['maya','Maya Chen','A little help with our workspace','Getting started',2,'owner',0,['Hi there! We’re getting our team set up and I had a quick question. Can we create separate spaces for our different projects?','Hey Maya! Absolutely. You can create a space for each project, then invite just the teammates who need access.','Happy to walk you through setting up your first one.','That would be amazing, thank you!']],
['noah','Noah Williams','Inviting the rest of my team','Account',8,'',0,['Hello! I’m moving our team into one workspace.','Can I invite everyone in one go?']],
['fatima','Fatima Bello','A question about billing','Billing',14,'',1,['Hi, I’m putting together our monthly expenses.','Where can I find our latest invoice?']],
['oliver','Oliver Park','Loving the new update','Feedback',32,'owner',0,['Just wanted to say the new workspace looks great. The team is loving it!']],
['sofia','Sofia Garcia','Setting up our first project','Getting started',48,'',0,['We’re about to kick off our first project. Is there a template we can start with?']]
] as const;
const statements=[db.prepare('INSERT OR IGNORE INTO workspace (id,owner_id,brand,greeting,color,availability) VALUES (?,?,?,?,?,?)').bind('main',owner,'Relay','Hi there. How can we help?','#087a57','We usually reply in a few minutes')];
for(const [key,name,title,tag,minutes,assigned,priority,texts] of items){const id='sample-'+key;const t=now-minutes*60000;statements.push(db.prepare('INSERT OR IGNORE INTO conversations (id,token_hash,name,email,title,status,assigned,priority,unread,sample,tag,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,'disabled',name,key+'@example.com',title,'open',assigned,priority,1,1,tag,t-180000,t));for(let i=0;i<texts.length;i++){const agent=key==='maya'&&(i===1||i===2);statements.push(db.prepare('INSERT OR IGNORE INTO messages (id,conversation_id,kind,body,sender,created_at) VALUES (?,?,?,?,?,?)').bind(id+'-'+i,id,agent?'agent':'visitor',texts[i],agent?'You':name,t-(texts.length-1-i)*60000));}}
await db.batch(statements);}
