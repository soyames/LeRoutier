import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const APP='http://127.0.0.1:4173';
async function login(page){
  await page.goto(APP+'/account');
  await page.getByText('Profils TEST — tous les espaces',{exact:true}).click();
  await page.getByRole('button',{name:'TEST : Voyageur',exact:true}).click();
}
async function downloadPdf(page,name){
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'Télécharger le PDF',exact:true}).click();
  const file=await download;expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  await file.saveAs(`.tmp/${name}.pdf`);
  expect((await readFile(await file.path())).subarray(0,5).toString()).toBe('%PDF-');
}
for(const width of [390,1280]) test(`documents: real ticket, invoice, label, print and share at ${width}px`,async({page})=>{
  test.setTimeout(90000);await page.setViewportSize({width,height:900});await login(page);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const open=page.getByRole('button',{name:'Afficher mon billet'}).first();
  await open.click();
  const dialog=page.getByRole('dialog',{name:'Mes documents LeRoutier'});
  await expect(dialog).toBeVisible();await expect(dialog.getByText('TEST Passenger',{exact:true})).toBeVisible();
  const manual=await dialog.locator('.ticket-code').innerText();expect(manual).toMatch(/^LR-/);
  await downloadPdf(page,`ticket-${width}`);
  await dialog.screenshot({path:`.tmp/ticket-document-${width}.png`});
  // Native dialog and print styles isolate the selected document.
  await page.emulateMedia({media:'print'});
  await expect(page.locator('#root')).toBeHidden();await expect(dialog.locator('.document-toolbar')).toBeHidden();
  await expect(dialog.locator('.lr-document')).toBeVisible();
  await page.pdf({path:`.tmp/ticket-print-${width}.pdf`,format:'A4',printBackground:true});
  await page.emulateMedia({media:'screen'});
  await page.evaluate(()=>{window.print=()=>{document.documentElement.dataset.printed='yes';};});
  await page.getByRole('button',{name:'Imprimer',exact:true}).click();
  expect(await page.locator('html').getAttribute('data-printed')).toBe('yes');
  await page.getByRole('button',{name:'Facture de transport',exact:true}).click();
  await downloadPdf(page,`invoice-${width}`);await expect(dialog.locator('.document-qr')).toHaveCount(0);
  await page.evaluate(()=>{
    Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});
    Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{document.documentElement.dataset.shared=data.files[0].type;}});
  });
  await page.getByRole('button',{name:'Partager',exact:true}).click();
  expect(await page.locator('html').getAttribute('data-shared')).toBe('application/pdf');
  await page.getByRole('button',{name:'Fermer les documents'}).click();await expect(open).toBeFocused();
  await open.click();expect(await dialog.locator('.ticket-code').innerText()).toBe(manual);
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button',{name:'Colis',exact:true}).click();
  await page.getByRole('button',{name:'Afficher le reçu et le QR'}).first().click();
  const reference=(await page.getByText(/Référence courte :/).innerText()).match(/LRP-[A-F0-9]{8}/)[0];
  await page.getByRole('button',{name:'Étiquette et reçu · PDF / impression'}).click();
  await expect(dialog.getByRole('heading',{name:'Expéditeur',exact:true})).toBeVisible();await expect(dialog.getByRole('heading',{name:'Destinataire',exact:true})).toBeVisible();
  await expect(dialog.locator('.document-sticker')).toBeVisible();
  await downloadPdf(page,`parcel-label-${width}`);await dialog.screenshot({path:`.tmp/parcel-document-${width}.png`});
  await page.getByRole('button',{name:'Reçu de dépôt',exact:true}).click();await downloadPdf(page,`parcel-receipt-${width}`);
  await page.getByRole('button',{name:'Fermer les documents'}).click();
  // The receiver can use the label's URL anonymously, without a credential.
  await page.goto(APP+'/parcels/track?ref='+reference);
  await expect(page.getByLabel('Numéro de suivi')).toHaveValue(reference);await page.getByRole('button',{name:'Suivre mon colis',exact:true}).click();
  await expect(page.getByRole('heading',{name:reference,exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
test('cancelled booking documents remain printable and do not claim a completed refund',async({page})=>{
  await login(page);await page.locator('.ticket').first().getByRole('button',{name:'Annuler',exact:true}).click();
  await expect(page.locator('.ticket').first().getByText('Annulé',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Afficher mon billet'}).first().click();
  await page.getByRole('button',{name:'Annulation / remboursement',exact:true}).click();
  await expect(page.getByText('Remboursement à examiner — aucun versement confirmé',{exact:true})).toBeVisible();
  await downloadPdf(page,'cancellation');
});
test('camera denial leaves public reference entry usable',async({page})=>{
  await page.goto(APP+'/parcels/track');
  await page.evaluate(()=>Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{throw new DOMException('Denied','NotAllowedError');}}));
  await page.getByRole('button',{name:'Scanner le QR du colis'}).click();
  await expect(page.getByRole('alert')).toContainText('Caméra indisponible');
  await page.getByLabel('Numéro de suivi').fill('LRP-00000000');await page.getByRole('button',{name:'Suivre mon colis',exact:true}).click();
  await expect(page.getByText('Ce numéro de suivi est introuvable. Vérifiez les caractères saisis.')).toBeVisible();
});
