// Public production journeys only. A browser route guard blocks every write,
// including if a future UI regression accidentally submits a mutation.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const origin=process.env.PROD_APP_URL || 'https://leroutier.app';
const browser=await chromium.launch();
let checks=0;
try {
  await mkdir('.tmp/production',{recursive:true});
  for (const width of [390,1280]) {
    const context=await browser.newContext({viewport:{width,height:900},locale:'fr-FR'});
    const page=await context.newPage(),errors=[],writes=[];
    page.on('pageerror',e=>errors.push(e.message));
    await context.route('**/*',route=>{
      if (!['GET','HEAD','OPTIONS'].includes(route.request().method())) { writes.push(route.request().method()); return route.abort(); }
      return route.continue();
    });
    await page.goto(origin);await page.getByLabel('Départ',{exact:true}).selectOption('place');
    await page.getByLabel('Ville de départ').fill('Cotonou');await page.getByRole('option',{name:'Cotonou',exact:true}).click();
    await page.getByLabel('Destination',{exact:true}).fill('Parakou');await page.getByRole('option',{name:'Parakou',exact:true}).click();
    await page.getByRole('button',{name:'Rechercher un trajet',exact:true}).click();
    await page.getByRole('heading',{name:'Cotonou → Parakou',exact:true}).waitFor({timeout:30000});
    await page.getByText('Aucun départ disponible pour cet itinéraire pour le moment.',{exact:true}).or(page.getByRole('button',{name:'Choisir',exact:true}).first()).waitFor();
    assert.equal(await page.getByRole('heading',{name:'Connexion requise',exact:true}).count(),0);
    assert.equal(await page.getByText('TEST : Voyageur',{exact:true}).count(),0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:`.tmp/production/search-${width}.png`,fullPage:true});checks++;
    await page.goto(origin+'/parcels/track');await page.getByLabel('Numéro de suivi').fill('LRP-00000000');
    await page.getByRole('button',{name:'Suivre mon colis',exact:true}).click();
    await page.getByText('Ce numéro de suivi est introuvable. Vérifiez les caractères saisis.',{exact:true}).waitFor();checks++;
    await page.goto(origin+'/tickets');await page.getByRole('heading',{name:'Connexion requise',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:/TEST :|Développement :/}).count(),0);checks++;
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
    console.log(`PASS ${width}px: anonymous search, parcel reference, account gate; no writes`);
    await context.close();
  }
  console.log(`Production browser smoke: ${checks}/${checks} passed. No bookings, payments or test records created.`);
} finally { await browser.close(); }
