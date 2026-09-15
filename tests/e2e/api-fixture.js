const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const stops=['Cotonou','Bohicon','Dassa-Zoumè','Parakou'].map((city,sequence)=>({id:id(200+sequence),stopId:id(200+sequence),stop_id:id(200+sequence),city,name:'Gare démo',sequence,latitude:6.3,longitude:2.4}));
const service={id:id(30),route_name:'DEMO Cotonou → Parakou',operator_name:'Opérateur démo',registration:'DEMO-BUS-01',driver_name:'Conducteur Démo',status:'active',capacity:12,current_sequence:0,departure_at:'2026-09-15T06:30:00Z',is_demo:true,stops,
  availability:{origin:0,destination:3,available:12,capacity:12,stops,fare:{amountMinor:7500,currency:'XOF'},segments:[0,1,2].map(sequence=>({sequence,available:12,occupied:0}))}};
export async function mockApi(page) {
  const token=role=>`fixture-session-${role}`;
  await page.route('**/auth/config',r=>r.fulfill({json:{data:{demoLogin:true}}}));
  await page.route('**/auth/demo',r=>r.fulfill({json:{data:{token:token(r.request().postDataJSON().role),user:{id:id(2),role:r.request().postDataJSON().role,display_name:'Compte Démo'}}}}));
  await page.route('**/me',r=>{const role=(r.request().headers()['authorization']||'').replace('Bearer ','').split('-').at(-1)||'passenger';
    return r.fulfill({json:{data:{id:id(2),role,display_name:'Compte Démo',operator_id:role==='passenger'?null:id(1)}}});});
  await page.route('**/routes',r=>r.fulfill({json:{data:[{id:id(10),stops}]}}));
  await page.route('**/stops',r=>r.fulfill({json:{data:stops}}));
  await page.route('**/services?*',r=>r.fulfill({json:{data:[service]}}));
  await page.route('**/me/bookings',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/driver/service',r=>r.fulfill({json:{data:service}}));
  await page.route('**/services/*/manifest',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/ops/fleet',r=>r.fulfill({json:{data:{services:[service],vehicles:[{id:id(20),registration:'DEMO-BUS-01',capacity:12,status:'active'}]}}}));
  await page.route('**/ops/bookings',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/ops/provisioning',r=>r.fulfill({json:{data:{operators:[],users:[],routes:[],vehicles:[],places:[],stops:[]}}}));
  await page.route('**/incidents',r=>r.fulfill({json:{data:[]}}));
  // FedaPay / payouts / agentic Ops sections
  await page.route('**/payments/config',r=>r.fulfill({json:{data:{available:true}}}));
  await page.route('**/ops/payments*',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/ops/payouts',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/agent/approvals',r=>r.fulfill({json:{data:[]}}));
  // Driver earnings/payouts
  await page.route('**/driver/earnings',r=>r.fulfill({json:{data:{summary:{available:0,reserved:0,paid:0,reversed:0,currency:'XOF'},entries:[]}}}));
  await page.route('**/driver/payouts',r=>r.fulfill({json:{data:[]}}));
  await page.route('**/driver/payout-destinations',r=>r.fulfill({json:{data:[]}}));
}
