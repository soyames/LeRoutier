export function nodeHandler(fetchHandler) {
  return async (req,res)=>{
    try {
      const chunks=[];let size=0;
      for await(const chunk of req) {size+=chunk.length;if(size>16_384){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const headers=new Headers();
      for(const [key,value] of Object.entries(req.headers)) if(value) headers.set(key,Array.isArray(value)?value.join(','):String(value));
      const response=await fetchHandler(new Request('http://localhost'+req.url,{method:req.method,headers,
        ...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})}));
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    } catch {res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'UNAVAILABLE',message:'The service is temporarily unavailable.'}}));}
  };
}
