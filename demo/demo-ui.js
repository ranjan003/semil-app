(function () {
  var bar = document.getElementById('demo-bar');
  bar.textContent = '';
  var t = document.createElement('span'); t.textContent = 'Demo mode: runs entirely in this browser. Data is saved in this browser only and never sent anywhere.'; bar.append(t);
  var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Reset demo data';
  var armed = false; b.onclick = function () { if (!armed) { armed = true; b.textContent = 'Click again to erase and restart'; setTimeout(function () { armed = false; b.textContent = 'Reset demo data'; }, 4000); } else window.__demo.reset(); };
  bar.append(b);
  var label = { super_admin: 'Super Admin', hr_admin: 'HR', candidate: 'Candidate' };
  function addQuick() {
    var form = document.querySelector('.login form'); if (!form || document.querySelector('.demo-quick')) return;
    var box = document.createElement('div'); box.className = 'demo-quick';
    var h = document.createElement('h3'); h.textContent = 'Try it as:'; box.append(h);
    var row = document.createElement('div'); row.className = 'qk'; box.append(row);
    window.__demo.accounts.forEach(function (a) {
      var bt = document.createElement('button'); bt.type = 'button'; bt.textContent = a.full_name + ' (' + label[a.role] + ')';
      bt.onclick = function () { document.getElementById('email').value = a.email; document.getElementById('password').value = 'demo'; form.requestSubmit(); };
      row.append(bt);
    });
    var p = document.createElement('p'); p.textContent = 'Password for every demo account: demo. Suggested path: HR imports questions, builds and publishes a test, assigns Asha, then sign in as Asha to take it.'; box.append(p);
    form.parentNode.append(box);
  }
  new MutationObserver(addQuick).observe(document.getElementById('root'), { childList: true, subtree: true }); addQuick();
})();
