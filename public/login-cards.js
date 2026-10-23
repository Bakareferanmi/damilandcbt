const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function cardSheets(students, { section, session, website }) {
  const pages = [];
  for (let i = 0; i < students.length; i += 8) {
    const cards = students.slice(i, i + 8).map(s => `<article class="login-card">
      <header><img class="school-crest" src="/school-crest.png" alt="School crest"><b>DAMILAND CBT</b><span>Student login card</span></header>
      <h2>${esc(s.fullName)}</h2><p class="class-name">${esc(s.className)} · ${esc(session)}</p>
      <dl><div><dt>Student code</dt><dd>${esc(s.code)}</dd></div><div><dt>Password</dt><dd>${esc(s.password)}</dd></div></dl>
      <div class="card-signatures"><div><img src="/signatures/gm.png" alt="G.M signature"><span>G.M</span></div><div><img src="/signatures/principal.png" alt="Principal signature"><span>Principal</span></div></div>
      <footer>${esc(website)}<br>Keep your login details private.</footer>
    </article>`).join('');
    pages.push(`<section class="card-sheet"><div class="sheet-heading">${esc(section)} · ${esc(session)}<span>Sheet ${pages.length + 1} of ${Math.ceil(students.length / 8)}</span></div><div class="card-grid">${cards}</div></section>`);
  }
  return pages.join('');
}

// Read current saved passwords through the existing audited admin-only route.
// Do not reset a missing password or retain credentials in browser storage.
export async function loadCardPasswords(students, getPassword) {
  const cards = new Array(students.length), missing = [];
  let next = 0;
  await Promise.all(Array.from({length: Math.min(3, students.length)}, async () => {
    while (next < students.length) {
      const i = next++, student = students[i];
      const result = await getPassword(student.code);
      if (result.status === 404) { missing.push(student); continue; }
      if (!result.ok || !result.data.password) throw new Error(result.data.error || 'Could not load login details. Please retry.');
      cards[i] = { ...student, password: result.data.password };
    }
  }));
  return { cards: cards.filter(Boolean), missing };
}
