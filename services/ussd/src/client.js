// Provider-specific menus/authentication belong in a later adapter. Capacity stays in the API.
// The versioned transport (/api/v1) keeps one shared domain behind every client.
export function createUssdClient({baseUrl,accessToken}) {
  return async function call(path,{method='GET',body=undefined,idempotencyKey=undefined}={}) {
    if(!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path.');
    const response=await fetch(baseUrl.replace(/\/$/,'')+'/api/v1'+path,{method,headers:{'content-type':'application/json',authorization:'Bearer '+accessToken,
      ...(idempotencyKey?{'idempotency-key':idempotencyKey}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok) throw new Error('LeRoutier API action failed.');
    return (await response.json()).data;
  };
}
