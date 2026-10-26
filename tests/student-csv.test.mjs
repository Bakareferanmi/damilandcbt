import test from 'node:test';
import assert from 'node:assert/strict';
import {studentDetailsCsv} from '../public/login-cards.js';
const context={session:'2026/2027',website:'https://school.test'};
test('student CSV includes all six columns, UTF-8 BOM and complete selected details',()=>{
 const csv=studentDetailsCsv([{fullName:'Adé Bakare',className:'SS3 Art',code:'DAMILANDCBT001',password:'ABC234'}],context);
 assert.ok(csv.startsWith('\uFEFF"Full name","Class section","Session","Student code","Password","Login website"\r\n'));
 assert.ok(csv.includes('"Adé Bakare","SS3 Art","2026/2027","DAMILANDCBT001","ABC234","https://school.test"'));
 assert.equal(csv.split('\r\n').length,3);
});
test('CSV quotes commas, quotes and embedded newlines without losing values',()=>{
 const csv=studentDetailsCsv([{fullName:'Ada, "Bola"\nBakare',className:'SS3 Art',code:'CODE1',password:'ABC234'}],context);
 assert.ok(csv.includes('"Ada, ""Bola""\nBakare"'));
});
test('spreadsheet formulas in text are neutralised',()=>{
 for(const fullName of ['=SUM(1,2)',' +SUM(1,2)','@SUM(1,2)','-1+2','\tformula']){
  const csv=studentDetailsCsv([{fullName}],context);
  assert.ok(csv.includes('"\''+fullName.replaceAll('"','""')+'"'));
 }
});
