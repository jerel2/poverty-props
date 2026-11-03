/* Poverty Props model engine. Shared by the page (browser) and the update job (Node). */
(function(root){
"use strict";
const STATS={
 NBA:[
  {k:"pts",l:"PTS",min:5,kind:"nb",step:1},{k:"reb",l:"REB",min:2.5,kind:"nb",step:1},{k:"ast",l:"AST",min:1.5,kind:"nb",step:1},
  {k:"fg3m",l:"3PM",min:0.8,kind:"nb",step:1},{k:"stl",l:"STL",min:0.8,kind:"nb",step:1},{k:"blk",l:"BLK",min:0.8,kind:"nb",step:1},
  {k:"tov",l:"TOV",min:1.2,kind:"nb",step:1},
  {k:"pra",l:"PRA",min:10,kind:"nb",step:1,of:["pts","reb","ast"]},{k:"pr",l:"P+R",min:8,kind:"nb",step:1,of:["pts","reb"]},
  {k:"pa",l:"P+A",min:8,kind:"nb",step:1,of:["pts","ast"]},{k:"ra",l:"R+A",min:4,kind:"nb",step:1,of:["reb","ast"]}],
 NFL:[
  {k:"pass_yds",l:"Pass Yds",min:120,kind:"norm",step:5},{k:"pass_td",l:"Pass TD",min:0.7,kind:"nb",step:1},
  {k:"completions",l:"Comp",min:10,kind:"nb",step:1},{k:"pass_att",l:"Pass Att",min:15,kind:"nb",step:1},
  {k:"ints",l:"INT",min:0.4,kind:"nb",step:1},
  {k:"rush_yds",l:"Rush Yds",min:15,kind:"norm",step:5},{k:"rush_att",l:"Rush Att",min:5,kind:"nb",step:1},
  {k:"rec",l:"Rec",min:1.5,kind:"nb",step:1},{k:"rec_yds",l:"Rec Yds",min:15,kind:"norm",step:5},
  {k:"rush_rec_yds",l:"Rush+Rec Yds",min:30,kind:"norm",step:5,of:["rush_yds","rec_yds"]}],
 NHL:[
  {k:"pts",l:"Points",min:0.3,kind:"nb",step:1},{k:"g",l:"Goals",min:0.15,kind:"nb",step:1},{k:"a",l:"Assists",min:0.2,kind:"nb",step:1},
  {k:"sog",l:"Shots",min:1.2,kind:"nb",step:1},{k:"blk",l:"Blocks",min:0.8,kind:"nb",step:1},{k:"hits",l:"Hits",min:1,kind:"nb",step:1},
  {k:"saves",l:"Saves",min:15,kind:"nb",step:1}]
};
STATS.MCBB=STATS.NBA;
const BASE_COLS={NBA:["pts","reb","ast","fg3m","stl","blk","tov"],NFL:["pass_yds","pass_td","completions","pass_att","ints","rush_yds","rush_att","rec","rec_yds"],
  NHL:["pts","g","a","sog","blk","hits","saves"],MCBB:["pts","reb","ast","fg3m","stl","blk","tov"]};
const LEAGUES=["NBA","NFL","NHL","MCBB"];
// Compact row layouts used in storage
const ROW={NBA:["date","opp","ha","min","pts","reb","ast","fg3m","stl","blk","tov","post","team"],
           NFL:["date","opp","ha","pass_yds","pass_td","completions","pass_att","ints","rush_yds","rush_att","rec","rec_yds","post","team","week"],
           NHL:["date","opp","ha","min","pts","g","a","sog","blk","hits","saves","post","team"],
           MCBB:["date","opp","ha","min","pts","reb","ast","fg3m","stl","blk","tov","post","team"]};
const DEFAULT_YEARS={NBA:5,NFL:10,NHL:5,MCBB:5};
const MODEL_WEIGHT=0.6; // how far a projection may move off the market estimate (0 = trust market, 1 = trust logs)

function lgamma(x){const g=7,c=[0.99999999999980993,676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];
 if(x<0.5)return Math.log(Math.PI/Math.sin(Math.PI*x))-lgamma(1-x);x-=1;let a=c[0];const t=x+g+0.5;for(let i=1;i<9;i++)a+=c[i]/(x+i);return 0.5*Math.log(2*Math.PI)+(x+0.5)*Math.log(t)-t+Math.log(a);}
function erf(x){const s=Math.sign(x);x=Math.abs(x);const t=1/(1+0.3275911*x);const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);return s*y;}
const Phi=z=>0.5*(1+erf(z/Math.SQRT2));
function makeDist(kind,mu,varr){
  mu=Math.max(mu,0.05);
  if(kind==="norm"){const sd=Math.sqrt(Math.max(varr,(0.22*mu)**2,1));return{kind,mu,sd,cdf:x=>Phi((x-mu)/sd),pmf:()=>0};}
  const v=Math.max(varr,mu*1.0001);
  // cumulative table built once per distribution (fast enough for thousands of props on a phone)
  const withTable=(pmfRaw,kind,sd)=>{const pm=[],cum=[];const ensure=k=>{for(let i=pm.length;i<=k;i++){pm[i]=pmfRaw(i);cum[i]=(i?cum[i-1]:0)+pm[i];}};
    return{kind,mu,sd,pmf:k=>{k=Math.floor(k);if(k<0)return 0;ensure(k);return pm[k];},cdf:k=>{k=Math.floor(k);if(k<0)return 0;ensure(k);return Math.min(1,cum[k]);}};};
  if(v<=mu*1.05)return withTable(k=>Math.exp(-mu+k*Math.log(mu)-lgamma(k+1)),"pois",Math.sqrt(mu));
  const r=mu*mu/(v-mu),p=r/(r+mu);const lr=lgamma(r),lp=r*Math.log(p),lq=Math.log(1-p);
  return withTable(k=>Math.exp(lgamma(k+r)-lr-lgamma(k+1)+lp+k*lq),"nb",Math.sqrt(v));
}
function sides(d,L){
  if(d.kind==="norm"){const u=d.cdf(L);return{over:1-u,under:u,push:0};}
  if(Number.isInteger(L)){const push=d.pmf(L);const under=d.cdf(L-1);return{over:1-under-push,under,push};}
  const under=d.cdf(Math.floor(L));return{over:1-under,under,push:0};
}
const amToProb=a=>a<0?-a/(-a+100):100/(a+100);
const probToAm=p=>{p=Math.min(0.985,Math.max(0.015,p));const a=p>=0.5?-100*p/(1-p):100*(1-p)/p;const r=Math.round(a/5)*5;return r===0?100:(r>-100&&r<100?(r<0?-100:100):r);};
const payout=a=>a<0?100/-a:a/100;
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN;
function sdev(a){if(a.length<2)return 0;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));}
function wstats(vals,decay=0.92){let sw=0,sm=0;vals.forEach((v,i)=>{const w=decay**i;sw+=w;sm+=w*v;});const m=sm/sw;let sv=0;vals.forEach((v,i)=>{sv+=decay**i*(v-m)**2;});return{mean:m,var:vals.length>1?sv/sw*vals.length/(vals.length-1):m};}
const num=v=>v===""||v==null?NaN:+v;
const nameKey=n=>String(n||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g,"").replace(/[^a-z]/g,"");
const TEAM_ALIAS={
 NBA:{GS:"GSW",NY:"NYK",SA:"SAS",NO:"NOP",NOH:"NOP",UTAH:"UTA",WSH:"WAS",PHO:"PHX",BRK:"BKN",NJN:"BKN",NJ:"BKN",CHO:"CHA",CHH:"CHA",SEA:"OKC",VAN:"MEM"},
 NFL:{OAK:"LV",SD:"LAC",STL:"LA",LAR:"LA",JAC:"JAX",WSH:"WAS",ARZ:"ARI",HST:"HOU",BLT:"BAL",CLV:"CLE",KAN:"KC",GNB:"GB",NWE:"NE",NOR:"NO",SFO:"SF",TAM:"TB",LVR:"LV"}};
TEAM_ALIAS.NHL={ARI:"UTA",UTAH:"UTA","L.A":"LAK",LA:"LAK","N.J":"NJD",NJ:"NJD","S.J":"SJS",SJ:"SJS","T.B":"TBL",TB:"TBL",MON:"MTL",WAS:"WSH",CLB:"CBJ",NAS:"NSH"};
TEAM_ALIAS.MCBB={};
const team=(lg,t)=>{t=String(t||"").trim().toUpperCase();return (TEAM_ALIAS[lg]||{})[t]||t;};
const valOf=(def,r)=>def.of?def.of.reduce((s,c)=>s+num(r[c]),0):num(r[def.k]);

/* Model one stat for one player.
   rows: games played, newest first, objects with stat keys and min (NBA).
   ctx: {opp, expMin (number|NaN), status}
   Returns null when the stat doesn't qualify, else stored params. */
function modelStat(def,rows,ctx){
  const rs=rows.filter(x=>Number.isFinite(valOf(def,x)));
  if(rs.length<3)return null;
  const vals=rs.map(x=>valOf(def,x));
  const w=wstats(vals.slice(0,20));
  if(w.mean<def.min)return null;
  if(def.of){const parts=def.of.map(c=>mean(rs.slice(0,20).map(x=>num(x[c])).filter(Number.isFinite)));if(parts.some(m=>!(m>=w.mean*0.12)))return null;}
  let scale=1;const mm=rs.map(x=>num(x.min)).filter(Number.isFinite).slice(0,10);const wm=mm.length?wstats(mm).mean:NaN;
  if(Number.isFinite(ctx.expMin)&&Number.isFinite(wm)&&wm>0)scale=clamp(ctx.expMin/wm,0.6,1.4);
  const vs=rs.filter(x=>x.opp===ctx.opp),vsVals=vs.map(x=>valOf(def,x));
  // matchup effect: how the player did vs this opponent relative to his own level at the time
  // (his previous 20 games), last 3 seasons only, shrunk toward no effect (n/(n+15)) and capped at +/-10%
  const cutoff=ctx.asOf?shiftYears(ctx.asOf,-3):"";const ratios=[];
  rs.forEach((x,i)=>{if(x.opp!==ctx.opp||x.date<cutoff)return;const base=vals.slice(i+1,i+21);if(base.length<8)return;const bm=mean(base);if(bm<def.min*0.5)return;ratios.push(vals[i]/bm);});
  const b=ratios.length/(ratios.length+15);
  const effect=ratios.length?clamp(1+b*(mean(ratios)-1),0.9,1.1):1;
  const muRaw=w.mean*scale*effect;
  const sea=mean(vals.slice(0,40)),l10=mean(vals.slice(0,10)),l5=mean(vals.slice(0,5));
  // estimated book line: books lean on recent form and price role/minutes changes right away,
  // so the only edge left for the model is matchup history (the vs-opponent blend)
  const muM=(0.3*sea+0.7*w.mean)*scale;
  const mu=muM+MODEL_WEIGHT*(muRaw-muM);
  const unc=1+1.5/Math.sqrt(Math.min(vals.length,40));
  const ratio=Math.max(1.0,w.var/Math.max(w.mean,0.1));
  const kind=def.kind==="norm"?"norm":"nb";
  const varT=kind==="norm"?w.var*scale*scale*unc:mu*ratio*unc;
  const varM=kind==="norm"?w.var*unc:muM*ratio*unc;
  const estLine=kind==="norm"?Math.round(muM/def.step)*def.step+0.5:Math.max(0.5,Math.round(muM-0.5)+0.5);
  const sdT=Math.sqrt(makeDist(kind,mu,varT).sd**2);
  let risk=1+clamp(sdT/Math.max(mu,0.1)*5,0,4);
  const n=vals.length;risk+=n<5?2.5:n<10?1.5:n<15?0.5:0;
  const allMin=rows.map(x=>num(x.min)).filter(Number.isFinite).slice(0,10);
  if(allMin.length>3)risk+=clamp(sdev(allMin)/Math.max(mean(allMin),1)*5,0,1.5);
  const st=String(ctx.status||"");
  if(/question|gtd/i.test(st))risk+=2;else if(/doubt/i.test(st))risk+=3;else if(/probable/i.test(st))risk+=0.5;
  if(ctx.unverified)risk+=0.5;
  risk+=clamp(Math.abs(l5-sea)/Math.max(sea,0.5)*3,0,1.5);
  return{s:def.k,kind,mu:r3(mu),varT:r3(varT),muM:r3(muM),varM:r3(varM),estLine,risk:r3(risk),n,
    sea:r3(sea),l10:r3(l10),l5:r3(l5),vsN:vsVals.length,effect:r3(effect),effN:ratios.length,vsAvg:vsVals.length?r3(mean(vsVals)):null,scale:r3(scale)};
}
const r3=x=>Math.round(x*1000)/1000;
function shiftYears(d,n){const x=new Date(d+"T12:00:00Z");x.setUTCFullYear(x.getUTCFullYear()+n);return x.toISOString().slice(0,10);}

/* Alt-line ladder from stored params. real: {line, over_odds, under_odds} or null */
function ladder(p,def,real){
  const dT=makeDist(p.kind,p.mu,p.varT),dM=makeDist(p.kind,p.muM,p.varM);
  const main=real?+real.line:p.estLine;const out=[];
  for(let i=-6;i<=6;i++){
    const L=+(main+i*def.step).toFixed(1);if(L<=0)continue;
    const t=sides(dT,L),m=sides(dM,L);
    ["over","under"].forEach(sd=>{
      let price,est=true;const ro=real?real[sd+"_odds"]:null;
      if(real&&i===0&&ro!==""&&ro!=null&&Number.isFinite(+ro)){price=+ro;est=false;}
      else{const mp=m[sd]/(1-m.push||1);price=probToAm(clamp(mp+0.0225,0.03,0.97));}
      const imp=amToProb(price),pr=t[sd],q=1-t[sd]-t.push;
      out.push({L,side:sd,price,est,imp,p:pr,edge:pr-imp,ev:pr*payout(price)-q,main:i===0});
    });
  }
  return{main,rungs:out,dT,dM};
}
function best(rungs,baseRisk,f){
  const maxImp=amToProb(f.maxJuice),minImp=amToProb(f.maxPlus);let b=null;
  rungs.forEach(c=>{if(c.imp>maxImp+1e-9||c.imp<minImp-1e-9||c.p<0.45)return;
    const risk=clamp(baseRisk+(c.p<0.55?(0.55-c.p)*8:0),1,10);const cand={...c,risk,vr:c.ev/risk};if(!b||cand.ev>b.ev)b=cand;});
  return b;
}
function seasonOf(lg,date){const y=+date.slice(0,4),m=+date.slice(5,7);
  if(lg!=="NFL"){const s=m>=9?y:y-1;return s+"-"+String(s+1).slice(2);} return String(m>=8?y:y-1);}
// props are stored as short arrays to keep the daily files small
const PROP_KEYS=["s","kind","mu","varT","muM","varM","estLine","risk","n","sea","l10","l5","vsN","vsAvg","scale","effect","effN"];
const encodeProp=p=>PROP_KEYS.map(k=>p[k]===undefined?null:p[k]);
const decodeProp=a=>Array.isArray(a)?Object.fromEntries(PROP_KEYS.map((k,i)=>[k,a[i]])):a;
const decodeRow=(lg,a)=>{const o={};ROW[lg].forEach((k,i)=>o[k]=a[i]);o.home_away=o.ha?"H":"A";return o;};

const Engine={STATS,BASE_COLS,LEAGUES,PROP_KEYS,encodeProp,decodeProp,ROW,DEFAULT_YEARS,MODEL_WEIGHT,lgamma,Phi,makeDist,sides,amToProb,probToAm,payout,clamp,mean,sdev,wstats,num,nameKey,TEAM_ALIAS,team,valOf,modelStat,ladder,best,seasonOf,decodeRow};
root.Engine=Engine;
if(typeof module!=="undefined"&&module.exports)module.exports=Engine;
})(typeof window!=="undefined"?window:globalThis);
