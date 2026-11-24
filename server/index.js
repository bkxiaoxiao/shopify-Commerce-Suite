import {loadConfig} from './config.js';
import {createStore} from './store.js';
import {ShopifyService} from './shopify.js';
import {createApplication} from './application.js';
import {createJobRunner} from './jobs.js';

const config=loadConfig();
const store=await createStore(config);
if(config.dbAutoMigrate)await store.init({skipLock:store.demoPglite});
await store.ready();
const shopify=new ShopifyService(config,store);
const runJobs=createJobRunner({config,store,shopify});
const server=createApplication({config,store,shopify,runJobs});
server.requestTimeout=60000;
server.headersTimeout=15000;
server.listen(config.port,config.host,()=>console.log(JSON.stringify({severity:'INFO',message:'Commerce Suite ready',mode:config.mode,port:config.port,persistence:config.databaseUrl?'postgresql':'ephemeral-demo'})));
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;server.close(async()=>{await store.close();process.exit(0);});setTimeout(()=>process.exit(1),9000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
