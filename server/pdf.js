import {fileURLToPath} from 'node:url';
import {renderDocumentPdf} from './domain/documents.js';

// Loading/subsetting a Unicode font is memory-intensive. Keep one renderer per
// Cloud Run instance; other requests wait briefly instead of multiplying RSS.
let tail=Promise.resolve();
let queued=0;
const font=fileURLToPath(new URL('./assets/fonts/NotoSansSC.ttf',import.meta.url));
export async function generatePdf(snapshot,options={}){
  if(queued>=8)throw Object.assign(new Error('PDF 服务繁忙，请稍后重试'),{status:503});
  queued++;
  const before=tail;let release;tail=new Promise(resolve=>{release=resolve;});
  await before;
  try{return await renderDocumentPdf(snapshot,{font,...options});}finally{queued--;release();}
}
