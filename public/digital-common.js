export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
export async function api(path,{method='GET',body,...options}={}){
 const response=await fetch(path,{method,credentials:'same-origin',signal:AbortSignal.timeout(12000),...options,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
 const data=await response.json().catch(()=>({error:'The server did not return a valid response. Try again.'}));
 if(!response.ok)throw Object.assign(new Error(data.error||'Could not complete this request.'),{status:response.status,...data});
 return data;
}
export function parseQuestionsCSV(input){
 input=input.replace(/^\uFEFF/,'');const rows=[];let row=[],field='',quoted=false;
 for(let i=0;i<input.length;i++){
  const ch=input[i];if(quoted){if(ch==='"'&&input[i+1]==='"'){field+='"';i++}else if(ch==='"')quoted=false;else field+=ch}
  else if(ch==='"'){if(field.trim())throw Error('A quoted field must begin with a quotation mark.');quoted=true}
  else if(ch===','){row.push(field);field=''}
  else if(ch==='\n'||ch==='\r'){if(ch==='\r'&&input[i+1]==='\n')i++;row.push(field);if(row.some(s=>s.trim()))rows.push(row);row=[];field=''}
  else field+=ch;
 }
 if(quoted)throw Error('A quoted field is not closed. Check the CSV file.');row.push(field);if(row.some(s=>s.trim()))rows.push(row);
 if(rows.length<2)throw Error('The file has no questions.');
 const headers=rows.shift().map(s=>s.trim().toLowerCase()),required=['question','a','b','c','d','correct'];
 if(required.some(k=>!headers.includes(k))||new Set(headers).size!==headers.length)throw Error('Use unique columns: question,a,b,c,d,correct.');
 if(rows.length>200)throw Error('Upload at most 200 rows at a time. Each bank holds 70 questions.');
 return rows.map((values,i)=>{if(values.length!==headers.length)throw Error('Row '+(i+2)+' has the wrong number of columns. Quote any text containing commas.');return Object.assign({row:i+2},Object.fromEntries(headers.map((key,n)=>[key,values[n]])))});
}
export function note(el,message,bad=false){el.hidden=!message;el.textContent=message;el.className='msg '+(bad?'bad':'ok')}
