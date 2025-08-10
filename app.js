// ===== Local store =====
const Store = {
  key: 'bergson_recall_v1',
  load() {
    try {
      return JSON.parse(localStorage.getItem(this.key)) || {
        cards: [], reviews: [], settings: { dailyCap: 40, domainCap: 3 }
      };
    } catch { return { cards: [], reviews: [], settings: { dailyCap: 40, domainCap: 3 } }; }
  },
  save(state) { localStorage.setItem(this.key, JSON.stringify(state)); }
};
let state = Store.load();

// ===== Utils =====
const uid = () => Math.random().toString(36).slice(2)+Date.now().toString(36);
const today0 = () => new Date(new Date().toDateString()).getTime();
const now = () => Date.now();

function tagDomain(card){ return (card.tags?.[0] || 'misc').toLowerCase(); }

// ===== Scheduler (SM-2 variant, de-scored) =====
function schedule(card, quality, arousalNow){
  // map quality labels to q
  const q = Number(quality);
  // adjust EF by arousal
  const arBoost = arousalNow === 'H' ? 0.05 : (arousalNow === 'M' ? 0.02 : 0);
  card.ef = Math.max(1.3, Math.min(2.6, (card.ef ?? 2.3) + (0.1 - (5-q)*(0.08)) + arBoost));
  if(q < 3){
    card.reps = 0;
    card.interval = 1;
    card.due = today0() + 24*3600*1000;
    card.lapses = (card.lapses||0)+1;
  } else {
    card.reps = (card.reps||0)+1;
    if(card.reps === 1) card.interval = 1;
    else if(card.reps === 2) card.interval = 6;
    else card.interval = Math.round((card.interval || 6) * card.ef);
    // importance tweak
    const imp = card.importance || 'M';
    const impMul = imp === 'H' ? 0.8 : (imp === 'L' ? 1.2 : 1.0);
    card.interval = Math.max(1, Math.round(card.interval * impMul));
    card.due = today0() + card.interval*24*3600*1000;
  }
}

function dueCards(){
  const t = now();
  return state.cards.filter(c => (c.due ?? 0) <= t);
}

function buildDailyQueue(){
  const cap = state.settings.dailyCap || 40;
  // 1) all due
  let pool = dueCards();
  // 2) add new cards until cap
  const newCards = state.cards.filter(c => !c.due);
  // prioritize importance
  newCards.sort((a,b)=>{
    const p = {'H':0,'M':1,'L':2};
    return p[a.importance||'M'] - p[b.importance||'M'];
  });
  for(const c of newCards){
    if(pool.length >= cap) break;
    pool.push(c);
  }
  // 3) shuffle with domain anti-streak
  return mixByDomain(pool, state.settings.domainCap || 3);
}

function mixByDomain(cards, streakMax){
  const buckets = {};
  for(const c of cards){
    const d = tagDomain(c);
    (buckets[d] ||= []).push(c);
  }
  Object.values(buckets).forEach(list => list.sort(()=>Math.random()-0.5));
  const domains = Object.keys(buckets).sort(()=>Math.random()-0.5);
  const result = [];
  const counts = {};
  while(true){
    let placed = false;
    for(const d of domains){
      if(!buckets[d].length) continue;
      const last = result.at(-1);
      if(last && tagDomain(last) === d && (counts[d]||0) >= streakMax) continue;
      result.push(buckets[d].shift());
      counts[d] = (counts[d]||0)+1;
      placed = true;
      if(result.length >= cards.length) return result;
    }
    if(!placed) break;
  }
  return result;
}

// ===== UI state =====
let queue = [];
let current = null;

// ===== Render =====
function renderTabs(){
  const views = ['review','add','list','settings'];
  views.forEach(v=>{
    document.getElementById(`tab-${v}`).onclick = ()=>{
      document.querySelectorAll('nav button').forEach(b=>b.classList.remove('active'));
      document.getElementById(`tab-${v}`).classList.add('active');
      document.querySelectorAll('.view').forEach(s=>s.classList.remove('active'));
      document.getElementById(`view-${v}`).classList.add('active');
      if(v==='list') renderList();
    };
  });
}

function renderDailyMeta(){
  const due = dueCards().length;
  const newCount = state.cards.filter(c=>!c.due).length;
  const rest = queue.length + (current?1:0);
  document.getElementById('daily-meta').textContent =
    `到期 ${due} • 新卡 ${newCount} • 队列剩余 ${rest}`;
}

function nextCard(){
  if(!queue.length){
    queue = buildDailyQueue();
  }
  current = queue.shift() || null;
  renderCurrent();
}

function renderCurrent(){
  renderDailyMeta();
  const cue = document.getElementById('cue');
  const micro = document.getElementById('microtask');
  const content = document.getElementById('content');
  const context = document.getElementById('context');
  const links = document.getElementById('links');
  if(!current){
    cue.textContent = '今日已完成。去新增几张卡，或者明天见。';
    micro.textContent = '';
    content.textContent = '';
    context.textContent = '';
    links.textContent = '';
    return;
  }
  cue.textContent = current.cue;
  micro.textContent = `微任务：${current.microTask || '举例'}`;
  content.textContent = current.content || '';
  context.textContent = current.context ? `场景：${current.context}` : '';
  links.textContent = (current.tags?.length? `标签：${current.tags.join(' / ')}` : '');
  document.getElementById('review-note').value = '';
}

function handleAnswer(q){
  if(!current) return;
  const arousalNow = (document.querySelector('input[name="ar"]:checked')?.value) || 'L';
  // record
  state.reviews.push({
    cardId: current.id, ts: now(), quality: String(q), arousalNow,
    note: document.getElementById('review-note').value || ''
  });
  // schedule
  schedule(current, q, arousalNow);
  // progressive gist folding
  if((current.reps||0)===5 || (current.reps||0)===10 || (current.reps||0)===20){
    current.content = foldGist(current.content);
  }
  Store.save(state);
  nextCard();
}

function foldGist(text=''){
  // keep first sentence or 120 chars
  const s = text.split(/。|\.|\?|！|!/)[0] || text;
  return (s.length>120)? s.slice(0,117)+'…' : s;
}

// ===== Add / List / Import-Export =====
function bindAdd(){
  document.getElementById('add-form').addEventListener('submit', (e)=>{
    e.preventDefault();
    const c = {
      id: uid(),
      cue: $('#f-cue'), content: $('#f-content'), context: $('#f-context'),
      microTask: $('#f-micro'), tags: $('#f-tags').split(',').map(s=>s.trim()).filter(Boolean),
      importance: $('#f-imp'), arousal: $('#f-arousal'),
      ef: 2.3, interval: 0, reps: 0, lapses: 0, links: []
    };
    state.cards.push(c);
    Store.save(state);
    e.target.reset();
    alert('已添加');
  });
}

function renderList(){
  const q = $('#search').toLowerCase();
  const ul = document.getElementById('card-list');
  ul.innerHTML = '';
  state.cards.filter(c=>{
    const hay = [c.cue, c.content, (c.tags||[]).join(',')].join(' ').toLowerCase();
    return !q || hay.includes(q);
  }).slice().reverse().forEach(c=>{
    const li = document.createElement('li');
    li.innerHTML = `<strong>${escapeHtml(c.cue)}</strong>
      <div>${escapeHtml(c.content||'')}</div>
      <small>${(c.tags||[]).join(' / ')} · due: ${c.due? new Date(c.due).toLocaleDateString():'未排程'}</small>`;
    ul.appendChild(li);
  });
}

function bindSearch(){
  document.getElementById('search').addEventListener('input', renderList);
}

function bindExportImport(){
  document.getElementById('export').onclick = ()=>{
    const blob = new Blob([JSON.stringify(state,null,2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `bergson_recall_${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  };
  document.getElementById('import').addEventListener('change', async (e)=>{
    const file = e.target.files[0]; if(!file) return;
    const txt = await file.text();
    try{
      const obj = JSON.parse(txt);
      if(obj.cards && obj.reviews){
        state = obj; Store.save(state);
        alert('导入成功'); renderList();
      } else alert('文件格式不对');
    } catch { alert('解析失败'); }
  });
}

function bindSettings(){
  const cap = document.getElementById('daily-cap');
  const dcap = document.getElementById('domain-cap');
  cap.value = state.settings.dailyCap; dcap.value = state.settings.domainCap;
  cap.onchange = ()=>{ state.settings.dailyCap = Number(cap.value); Store.save(state); renderDailyMeta(); };
  dcap.onchange = ()=>{ state.settings.domainCap = Number(dcap.value); Store.save(state); };
  document.getElementById('reset').onclick = ()=>{
    if(confirm('确定清空所有数据？')){
      state = { cards: [], reviews: [], settings: { dailyCap: 40, domainCap: 3 } };
      Store.save(state); location.reload();
    }
  };
}

function registerSW(){
  const el = document.getElementById('sw-status');
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('service-worker.js').then(()=>{
      el.textContent = 'Service Worker: 已注册（可离线使用）';
    }).catch(()=>{ el.textContent = 'Service Worker: 注册失败'; });
  } else {
    el.textContent = 'Service Worker: 不支持';
  }
}

// ===== Helpers =====
function $(id){ return document.getElementById(id).value || ''; }
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// ===== Init =====
function init(){
  renderTabs();
  bindAdd(); bindSearch(); bindExportImport(); bindSettings();
  document.querySelectorAll('#answer-buttons button').forEach(b=>{
    b.onclick = ()=>handleAnswer(b.dataset.q);
  });
  nextCard();
  registerSW();
}
document.addEventListener('DOMContentLoaded', init);
