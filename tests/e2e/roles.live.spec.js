import { test, expect } from '@playwright/test';

const APP='http://127.0.0.1:4173';
async function login(page,label){
  await page.goto(APP+'/account');
  await page.getByText('Profils TEST : tous les espaces',{exact:true}).click();
  await page.getByRole('button',{name:'TEST : '+label,exact:true}).click();
  // Platform Ops has its own control plane and lands there, not on a company
  // operations console it has no operator scope for.
  const landing=label==='Voyageur'?'/tickets':label==='Exploitation plateforme'?'/ops/platform':label.startsWith('Exploitation')?'/ops/today':'/work/today';
  await expect(page).toHaveURL(APP+landing);
}
/** @type {Array<[string,string,string[]]>} */
const profiles=[
  ['Voyageur','/tickets',['Billets','Colis','Alertes','Compte']],
  ['Chauffeur indépendant','/work/today',['Aujourd’hui','Manifeste','Scanner','Comptant','Colis','Véhicule','Points','Recettes','Profil']],
  ['Conducteur de compagnie','/work/today',['Aujourd’hui','Manifeste','Scanner','Comptant','Colis','Véhicule','Profil']],
  ['Convoyeur','/work/today',['Service','Manifeste','Scanner','Comptant','Colis','Profil']],
  ['Exploitation compagnie','/ops/today',['Aujourd’hui','Services','Flotte','Équipage','Stations','Colis','Paiements','Règlements','Incidents','Alertes','Paramètres']],
  ['Exploitation plateforme','/ops/platform',['Vue plateforme','Opérateurs','Vérifications','Utilisateurs','Services','Colis','Incidents','Finances','Système']],
];
for(const [label,path,links] of profiles) test(`TEST ${label}: mobile login, workspace and every navigation destination`,async({page})=>{
  test.setTimeout(120_000);
  await page.setViewportSize({width:390,height:844});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await login(page,label);await expect(page).toHaveURL(APP+path);
  await expect(page.getByText(/Espace TEST/)).toBeVisible();
  for(const name of links){
    await page.getByRole('navigation').getByRole('button',{name,exact:true}).click();
    await expect(page.getByRole('navigation').getByRole('button',{name,exact:true})).toHaveAttribute('aria-current','page');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.skeleton')).toHaveCount(0);
    // No alert except the capacity warning, which is a deliberate operational
    // notice on the screen built to carry it: DATABASE_STORAGE_LIMIT_MB is not
    // set on this database, so the registration gate genuinely cannot fire and
    // Platform Ops is told so. Any OTHER alert still fails the screen.
    for (const alert of await page.getByRole('alert').all()) {
      await expect(alert).toContainText(/Aucune limite de stockage n’est configurée/);
    }
    await expect(page.locator('main')).not.toBeEmpty();
    await expect(page.getByText('Espace non autorisé',{exact:true})).toHaveCount(0);
    // A bare true/false here says a screen overflows but not what did it, which
    // is most of the work. Name the elements that actually stick out, ignoring
    // deliberate horizontal scrollers whose own overflow is contained.
    const overflow=await page.evaluate(()=>{
      const limit=document.documentElement.clientWidth;
      if(document.documentElement.scrollWidth<=limit)return null;
      const describe=el=>el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+
        (typeof el.className==='string'&&el.className.trim()?'.'+el.className.trim().split(/\s+/).join('.'):'');
      const scrolls=el=>{const o=getComputedStyle(el).overflowX;return o==='auto'||o==='scroll'||o==='hidden';};
      const culprits=[...document.querySelectorAll('body *')].filter(el=>{
        const r=el.getBoundingClientRect();
        if(r.width===0&&r.height===0)return false;
        if(r.right<=limit+1&&r.left>=-1)return false;
        // A child kept inside a scroller is that scroller's business.
        for(let p=el.parentElement;p&&p!==document.body;p=p.parentElement)if(scrolls(p))return false;
        return true;
      }).map(el=>({el:describe(el),right:Math.round(el.getBoundingClientRect().right),
        left:Math.round(el.getBoundingClientRect().left),text:(el.textContent||'').trim().slice(0,60)}));
      return {scrollWidth:document.documentElement.scrollWidth,viewport:limit,
        culprits:culprits.slice(0,4)};
    });
    expect(overflow,`${label} › ${name} overflows at 390px: `+JSON.stringify(overflow)).toBeNull();
  }
  if(label==='Convoyeur'){
    await page.getByRole('navigation').getByRole('button',{name:'Service',exact:true}).click();
    await expect(page.getByRole('button',{name:'Activer le suivi du véhicule'})).toHaveCount(0);
    await expect(page.getByRole('button',{name:/Je suis arrivé/})).toHaveCount(0);
  }
  if(['Convoyeur','Conducteur de compagnie'].includes(label)) await expect(page.getByRole('navigation').getByRole('button',{name:'Recettes'})).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button',{name:links[0],exact:true}).click();
  await expect(page.getByRole('navigation').getByRole('button',{name:links[0],exact:true})).toHaveAttribute('aria-current','page');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.skeleton')).toHaveCount(0);
  await page.screenshot({path:`.tmp/role-${label.replaceAll(' ','-')}.png`,fullPage:true});
  if(path.startsWith('/work')){
    await page.getByRole('button',{name:'Changer d’espace'}).click();
    await page.getByRole('menuitem',{name:/Voyageur/}).click();
    await expect(page).toHaveURL(APP+'/trips');
    await expect(page.getByRole('button',{name:/Compte de TEST/})).toBeVisible();
  }
  expect(errors).toEqual([]);
});

// A video stream carries a QR rendered by the passenger UI through the real
// camera element and qr-scanner decoder. Physical handset optics remain a
// separate device check; no scanner callback or API response is mocked here.
async function camera(page,svg){
  await page.evaluate(async svg=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=640;
    const ctx=canvas.getContext('2d');const img=new Image();
    img.src='data:image/svg+xml;base64,'+btoa(svg);await img.decode();
    const draw=()=>{ctx.fillStyle='white';ctx.fillRect(0,0,640,640);ctx.drawImage(img,130,130,380,380);};
    draw();const timer=setInterval(draw,80);
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>canvas.captureStream(12)});
    window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
  },svg.replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" '));
}
test('camera decodes a passenger phone QR, shows the booking, confirms boarding and rejects reuse',async({browser})=>{
  const passenger=await browser.newPage(),driver=await browser.newPage();
  await login(passenger,'Voyageur');
  const card=passenger.locator('.ticket').filter({hasText:'TEST Corridor'}).first();
  await card.getByRole('button',{name:'Afficher mon billet'}).click();
  const svg=await passenger.locator('.document-dialog .ticket-qr svg').evaluate(el=>el.outerHTML);
  const manual=await passenger.locator('.document-dialog .ticket-qr .ticket-code').textContent();
  await login(driver,'Conducteur de compagnie');
  await driver.getByRole('navigation').getByRole('button',{name:'Scanner',exact:true}).click();
  await camera(driver,svg);
  await driver.getByRole('button',{name:'Scanner le QR',exact:true}).click();
  await expect(driver.getByText(/Billet vérifié · siège/)).toBeVisible();
  await expect(driver.getByText('TEST Passenger',{exact:true})).toBeVisible();
  await driver.screenshot({path:'.tmp/ticket-verified.png',fullPage:true});
  await driver.getByRole('button',{name:'Confirmer l’embarquement'}).click();
  await expect(driver.getByText('Embarquement confirmé.',{exact:true})).toBeVisible();
  await driver.getByRole('button',{name:'Scanner le QR',exact:true}).click();
  await expect(driver.getByText('Ce billet a déjà été utilisé pour embarquer.')).toBeVisible();
  await driver.getByLabel('Code du billet').fill(manual);
  await driver.getByRole('button',{name:'Valider le billet'}).click();
  await expect(driver.getByText('Ce billet a déjà été utilisé pour embarquer.')).toBeVisible();
  await driver.screenshot({path:'.tmp/ticket-camera.png',fullPage:true});
  await passenger.close();await driver.close();
});

test('parcel receipt reopens without printing, camera decodes it and handwritten reference resolves',async({browser})=>{
  const sender=await browser.newPage(),driver=await browser.newPage();
  await login(sender,'Voyageur');
  await sender.getByRole('navigation').getByRole('button',{name:'Colis',exact:true}).click();
  await sender.getByRole('button',{name:'Afficher le reçu et le QR'}).first().click();
  await expect(sender.getByText('Présentez ce QR depuis votre téléphone au conducteur. Aucune impression n’est nécessaire.')).toBeVisible();
  const svg=await sender.locator('.ticket-qr svg').evaluate(el=>el.outerHTML);
  const reference=(await sender.getByText(/Référence courte : LRP-/).innerText()).match(/LRP-[A-F0-9]{8}/)[0];
  // The company parcel is seeded last and is first in the sender's list.
  await login(driver,'Convoyeur');
  await driver.getByRole('navigation').getByRole('button',{name:'Colis',exact:true}).click();
  await camera(driver,svg);await driver.getByRole('button',{name:'Scanner le QR',exact:true}).click();
  await expect(driver.getByRole('button',{name:'Accepter et charger'})).toBeVisible();
  await driver.getByLabel('Référence LRP').fill(reference);
  await driver.getByRole('button',{name:'Rechercher',exact:true}).click();
  await expect(driver.getByRole('button',{name:'Accepter et charger'})).toBeVisible();
  await driver.screenshot({path:'.tmp/parcel-camera.png',fullPage:true});
  await driver.getByRole('button',{name:'Accepter et charger'}).click();
  await driver.getByRole('button',{name:'Scanner le départ'}).click();
  await driver.getByRole('button',{name:'Scanner l’arrivée'}).click();
  await expect(driver.getByText('L’exploitation confirme le point de retrait et prépare le code du destinataire.')).toBeVisible();
  const ops=await browser.newPage(),collector=await browser.newPage();
  await login(ops,'Exploitation compagnie');
  await ops.getByRole('navigation').getByRole('button',{name:'Colis',exact:true}).click();
  await ops.getByLabel('Numéro de suivi').fill(reference);
  await ops.getByRole('button',{name:'Rechercher',exact:true}).click();
  await ops.getByRole('button',{name:'Prêt au retrait',exact:true}).click();
  await ops.getByRole('button',{name:'Code de retrait',exact:true}).click();
  const pickup=(await ops.getByText(/Code de retrait \(15 min\) :/).innerText()).match(/: (\d{6})/)[1];
  await login(collector,'Conducteur de compagnie');
  await collector.getByRole('navigation').getByRole('button',{name:'Colis',exact:true}).click();
  await collector.getByRole('button',{name:'Remettre avec le code'}).click();
  await collector.getByLabel('Code de retrait du destinataire').fill(pickup);
  await collector.getByRole('button',{name:'Confirmer la remise'}).click();
  await expect(collector.getByText('Colis remis au destinataire.')).toBeVisible();
  await expect(collector.getByRole('button',{name:'Remettre avec le code'})).toHaveCount(0);
  await collector.screenshot({path:'.tmp/parcel-collected.png',fullPage:true});
  await sender.close();await driver.close();await ops.close();await collector.close();
});

test('offline manual boarding remains unverified until the server accepts it after reconnection',async({browser})=>{
  const passenger=await browser.newPage(),driver=await browser.newPage();
  await login(passenger,'Voyageur');
  const card=passenger.locator('.ticket').filter({hasText:'TEST Service Cotonou–Parakou'}).first();
  await card.getByRole('button',{name:'Afficher mon billet'}).click();
  const manual=await passenger.locator('.document-dialog .ticket-qr .ticket-code').textContent();
  await login(driver,'Chauffeur indépendant');
  await driver.getByRole('navigation').getByRole('button',{name:'Scanner',exact:true}).click();
  await expect(driver.getByLabel('Code du billet')).toBeVisible();
  await driver.context().setOffline(true);
  await driver.getByLabel('Code du billet').fill(manual);
  await driver.getByRole('button',{name:'Valider le billet'}).click();
  await expect(driver.getByText(/Embarquement en attente de vérification par le serveur/)).toBeVisible();
  await expect(driver.getByText('Embarquement confirmé.',{exact:true})).toHaveCount(0);
  await driver.context().setOffline(false);
  await expect(driver.getByText('Embarquement confirmé.',{exact:true})).toBeVisible();
  await passenger.close();await driver.close();
});
