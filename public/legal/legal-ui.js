(() => {
  const legalLinks = [
    ['KVKK aydınlatma', '/legal/kvkk.html'],
    ['Gizlilik', '/legal/gizlilik.html'],
    ['Kullanım koşulları', '/legal/kullanim.html'],
    ['Çerez politikası', '/legal/cerezler.html'],
    ['Mesafeli sözleşme', '/legal/mesafeli-satis.html'],
    ['Ön bilgilendirme', '/legal/on-bilgilendirme.html'],
    ['Cayma / iade', '/legal/iade-cayma.html'],
    ['Şirket bilgileri', '/legal/sirket-bilgileri.html'],
  ];

  if (!document.querySelector('footer')) {
    const footer = document.createElement('footer');
    const caption = document.createElement('span');
    caption.textContent = '© Vektör Yazılım & Tasarım · Yasal bilgilendirme';
    const nav = document.createElement('nav');
    for (const [label, href] of legalLinks) {
      const link = document.createElement('a');
      link.href = href;
      link.textContent = label;
      nav.append(link);
    }
    footer.append(caption, nav);
    (document.querySelector('.shell') || document.body).append(footer);
  }

  if (document.querySelector('#cookie-banner')) return;
  let saved;
  try { saved = JSON.parse(localStorage.getItem('tiktokLiveGame.privacyPreferences') || 'null'); } catch { saved = null; }

  const banner = document.createElement('section');
  banner.id = 'cookie-banner';
  banner.className = 'cookie-banner';
  banner.setAttribute('aria-labelledby', 'cookie-title');
  banner.setAttribute('aria-live', 'polite');
  banner.hidden = Boolean(saved);
  banner.innerHTML = '<div class="cookie-head"><div><h2 id="cookie-title">Gizlilik ve tarayıcı tercihleri</h2><p>TikTokLiveGame paneli token ve kullanıcı adı gibi tercihleri bu tarayıcıda hatırlamak için localStorage kullanır. Bu, HTTP çerezi değildir. Bu sürümde analitik/reklam SDK’sı etkin değildir. Ayrıntılar: <a href="/legal/cerezler.html">Çerez ve depolama politikası</a>.</p></div></div><div id="cookie-optional" class="cookie-options" hidden><label><input id="cookie-analytics" type="checkbox"> Analitik/performans (ileride etkinleştirilirse)</label><label><input id="cookie-marketing" type="checkbox"> Pazarlama (ileride etkinleştirilirse)</label><span style="color:#737a8e;font-size:10px">Bu seçenekler tercih arayüzü iskeletidir; bu projede isteğe bağlı izleme kodu çalıştırılmaz.</span></div><div class="cookie-actions"><button id="cookie-necessary" type="button">Yalnızca gerekli</button><button id="cookie-settings" type="button">Tercihleri seç</button><button id="cookie-all" class="primary" type="button">Tümünü kabul et</button></div>';
  document.body.append(banner);

  function savePreferences(analytics, marketing) {
    const preferences = { necessary: true, analytics, marketing, savedAt: new Date().toISOString(), version: 1 };
    try { localStorage.setItem('tiktokLiveGame.privacyPreferences', JSON.stringify(preferences)); } catch { /* Tercih saklanamazsa banner oturum boyunca açık kalabilir. */ }
    banner.hidden = true;
  }

  document.querySelector('#cookie-necessary').addEventListener('click', () => savePreferences(false, false));
  document.querySelector('#cookie-all').addEventListener('click', () => savePreferences(true, true));
  document.querySelector('#cookie-settings').addEventListener('click', (event) => {
    const options = document.querySelector('#cookie-optional');
    if (options.hidden) {
      options.hidden = false;
      event.currentTarget.textContent = 'Seçimi kaydet';
      return;
    }
    savePreferences(document.querySelector('#cookie-analytics').checked, document.querySelector('#cookie-marketing').checked);
  });

  const reopen = document.createElement('button');
  reopen.type = 'button';
  reopen.textContent = 'Çerez tercihleri';
  reopen.setAttribute('aria-label', 'Çerez tercihlerini aç');
  reopen.style.cssText = 'position:fixed;z-index:10;left:14px;bottom:12px;padding:7px 10px;border:1px solid #dedfeb;border-radius:8px;background:#fff;color:#555d70;font:inherit;font-size:10px;cursor:pointer';
  reopen.addEventListener('click', () => { banner.hidden = false; });
  document.body.append(reopen);
})();
