import {loadConfig} from './config.js';
import {createStore} from './store.js';
const config=loadConfig();
const store=await createStore(config);
try{await store.init({skipLock:!!store.demoPglite});console.log('Database schema is ready');}finally{await store.close();}
