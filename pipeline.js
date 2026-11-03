#!/usr/bin/env node
/* Poverty Props update pipeline.
   Usage: node pipeline.js --work DIR [--rotowire rw.json] [--xcheck xc.json] [--prev prev.json] [--today YYYY-MM-DD]
                           [--espn 1] [--site SITE_DIR]
     --espn 1   read injuries, game lines and the score cross-check straight from ESPN's public feeds
                (needs open internet, e.g. GitHub Actions)
     --site DIR also write every document to DIR/data/<id>.json plus DIR/data/current.json (static website)
   Downloads public data (GitHub only), checks it, models tonight's props, and writes:
     DIR/out/docs/*.json   one file per database document
     DIR/out/plan.json     batches to write, the pointer to set, and the previous run's docs to delete
     DIR/out/report.md     what was checked and what was flagged
   No external packages. Needs curl. */
"use strict";
const fs=require("fs"),path=require("path"),{execFileSync}=require("child_process");
const E=require(path.join(__dirname,"engine.js"));

const args={};process.argv.slice(2).forEach((a,i,arr)=>{if(a.startsWith("--"))args[a.slice(2)]=arr[i+1];});
const WORK=path.resolve(args.work||"ppwork");const RAW=path.join(WORK,"raw"),OUT=path.join(WORK,"out"),DOCS=path.join(OUT,"docs");
[RAW,OUT,DOCS].forEach(d=>fs.mkdirSync(d,{recursive:true}));
fs.readdirSync(DOCS).forEach(f=>fs.unlinkSync(path.join(DOCS,f)));
const etDate=d=>d.toLocaleDateString("en-CA",{timeZone:"America/New_York"});
const TODAY=args.today||etDate(new Date());
const report=[];const log=s=>{report.push(s);console.error(s);};
log(`# Update report\nRun: ${new Date().toISOString()} · Slate date (ET): ${TODAY}`);

/* ---------- download + CSV ---------- */
function get(url,file,{optional=false}={}){
  const dest=path.join(RAW,file);
  for(let i=0;i<3;i++){
    try{execFileSync("curl",["-sSfL","--retry","2","--max-time","180","-o",dest,url],{stdio:["ignore","ignore","pipe"]});
      const sz=fs.statSync(dest).size;if(sz>200)return dest;}catch(e){}
  }
  if(optional){log(`- Optional file unavailable: ${url}`);return null;}
  throw new Error("Download failed: "+url);
}
function parseCSV(text){
  const rows=[];let f="",row=[],q=false;
  for(let i=0;i<text.length;i++){const c=text[i];
    if(q){if(c==='"'){if(text[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}
    else if(c==='"')q=true;else if(c===","){row.push(f);f="";}
    else if(c==="\n"||c==="\r"){if(c==="\r"&&text[i+1]==="\n")i++;row.push(f);rows.push(row);row=[];f="";}else f+=c;}
  if(f!==""||row.length){row.push(f);rows.push(row);}
  const hdr=rows.shift();const idx={};hdr.forEach((h,i)=>idx[h]=i);
  return{idx,rows:rows.filter(r=>r.length>1)};
}
const readCSV=p=>parseCSV(fs.readFileSync(p,"utf8").replace(/^﻿/,""));
const col=(t,name)=>{if(!(name in t.idx))throw new Error("Missing column "+name);return t.idx[name];};
const n0=v=>v===""||v==null||v==="NA"?"":+v;

/* ---------- inputs from the job (optional) ---------- */
const readJSON=p=>{try{return p?JSON.parse(fs.readFileSync(p,"utf8")):null;}catch(e){log(`- Could not read ${p}: ${e.message}`);return null;}};
const RW=readJSON(args.rotowire),PREV=readJSON(args.prev);let XC=readJSON(args.xcheck);

/* ---------- ESPN feeds (only with --espn) ---------- */
const ESPN={inj:{},lines:{},ok:{}};
function getJSON(url){try{const out=execFileSync("curl",["-sSfL","--retry","2","--max-time","60","-H","User-Agent: Mozilla/5.0",url],{maxBuffer:64*1024*1024});return JSON.parse(out.toString());}catch(e){log(`- ESPN request failed: ${url}`);return null;}}
const ESPN_PATH={NBA:"basketball/nba",NFL:"football/nfl"};
const ymd=d=>d.replace(/-/g,"");
// walk any JSON and collect objects that look like injury entries (have an athlete and a status)
function findInjuries(node,team,out){
  if(!node||typeof node!=="object")return out;
  if(Array.isArray(node)){node.forEach(n=>findInjuries(n,team,out));return out;}
  const t=node.team&&node.team.abbreviation?node.team.abbreviation:(node.abbreviation&&node.injuries?node.abbreviation:team);
  const tname=node.displayName&&node.injuries?node.displayName:null;
  if(node.athlete&&(node.status||node.type)){out.push({team:(node.athlete.team&&node.athlete.team.abbreviation)||t||"",teamName:tname||"",id:String(node.athlete.id||""),name:node.athlete.displayName||node.athlete.fullName||"",
    status:String(node.status||(node.type&&(node.type.description||node.type.name))||""),detail:String(node.shortComment||"").slice(0,200),date:node.date||""});return out;}
  Object.keys(node).forEach(k=>{if(k!=="athlete")findInjuries(node[k],t||team,out);});
  if(tname)out.filter(x=>!x.teamName).forEach(x=>x.teamName=tname);
  return out;
}
function loadESPN(lg){
  const inj=getJSON(`https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[lg]}/injuries`);
  if(inj){const list=findInjuries(inj,"",[]);ESPN.inj[lg]=list;ESPN.ok[lg]=list.length>0;log(`- ESPN ${lg} injury feed: ${list.length} entries`);}
  // scoreboards: last few days for the cross-check, today/this week for game lines
  const xs=[];const back=lg==="NBA"?3:8;
  for(let i=-back;i<=(lg==="NBA"?0:6);i++){const d=addDays(TODAY,i);const sb=getJSON(`https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[lg]}/scoreboard?dates=${ymd(d)}`);if(!sb||!sb.events)continue;
    sb.events.forEach(ev=>{const c=ev.competitions&&ev.competitions[0];if(!c)return;const h=c.competitors.find(x=>x.homeAway==="home"),a=c.competitors.find(x=>x.homeAway==="away");if(!h||!a)return;
      const H=E.team(lg,h.team.abbreviation),A=E.team(lg,a.team.abbreviation);
      if(c.status&&c.status.type&&c.status.type.completed&&i<0)xs.push({date:etDate(new Date(ev.date)),away:A,home:H,away_score:+a.score,home_score:+h.score});
      const o=c.odds&&c.odds[0];if(o&&i>=0)ESPN.lines[lg+"|"+A+"@"+H]={spread:o.details||"",total:o.overUnder!=null?String(o.overUnder):"",src:o.provider&&o.provider.name?`${o.provider.name} via ESPN`:"ESPN"};});}
  return xs;
}

const NBA30=new Set(["ATL","BOS","BKN","CHA","CHI","CLE","DAL","DEN","DET","GSW","HOU","IND","LAC","LAL","MEM","MIA","MIL","MIN","NOP","NYK","OKC","ORL","PHI","PHX","POR","SAC","SAS","TOR","UTA","WAS"]);
const NBA_NICK={hawks:"ATL",celtics:"BOS",nets:"BKN",hornets:"CHA",bulls:"CHI",cavaliers:"CLE",mavericks:"DAL",nuggets:"DEN",pistons:"DET",warriors:"GSW",rockets:"HOU",pacers:"IND",clippers:"LAC",lakers:"LAL",grizzlies:"MEM",heat:"MIA",bucks:"MIL",timberwolves:"MIN",pelicans:"NOP",knicks:"NYK",thunder:"OKC",magic:"ORL","76ers":"PHI",sixers:"PHI",suns:"PHX","trail blazers":"POR",blazers:"POR",kings:"SAC",spurs:"SAS",raptors:"TOR",jazz:"UTA",wizards:"WAS"};
const NFL_NICK={cardinals:"ARI",falcons:"ATL",ravens:"BAL",bills:"BUF",panthers:"CAR",bears:"CHI",bengals:"CIN",browns:"CLE",cowboys:"DAL",broncos:"DEN",lions:"DET",packers:"GB",texans:"HOU",colts:"IND",jaguars:"JAX",chiefs:"KC",raiders:"LV",chargers:"LAC",rams:"LA",dolphins:"MIA",vikings:"MIN",patriots:"NE",saints:"NO",giants:"NYG",jets:"NYJ",eagles:"PHI",steelers:"PIT","49ers":"SF",seahawks:"SEA",buccaneers:"TB",titans:"TEN",commanders:"WAS"};
const nflTeamFrom=s=>{const k=String(s||"").toLowerCase().trim();const n=Object.keys(NFL_NICK).find(x=>k.endsWith(x));return n?NFL_NICK[n]:E.team("NFL",s);};
const nbaTeamFrom=s=>{s=String(s||"").trim();const k=s.toLowerCase().replace(/\s*\(.*\)\s*$/,"");return NBA_NICK[k]||NBA_NICK[Object.keys(NBA_NICK).find(n=>k.endsWith(n))]||E.team("NBA",s);};
const statusNorm=s=>{s=String(s||"").trim();if(/^(out|ofs|o)$/i.test(s)||/out/i.test(s))return"Out";if(/doub/i.test(s))return"Doubtful";if(/gtd|game.?time/i.test(s))return"Questionable";if(/ques/i.test(s))return"Questionable";if(/prob/i.test(s))return"Probable";if(/sus/i.test(s))return"Out";return s||"";};

/* ---------- shared builders ---------- */
function compact(lg,o){return E.ROW[lg].map(k=>o[k]===undefined?"":o[k]);}
function byPlayer(rows){const m=new Map();rows.forEach(r=>{if(!m.has(r.id))m.set(r.id,[]);m.get(r.id).push(r);});m.forEach(a=>a.sort((x,y)=>x.date<y.date?1:x.date>y.date?-1:0));return m;}

// match injury-report names ("A. Caruso") to real players on that team
function matchName(raw,teamCode,teamPlayers,allPlayers){
  const rk=E.nameKey(raw);const parts=String(raw).replace(/\./g," ").trim().split(/\s+/);
  const tryList=list=>{
    const exact=list.filter(p=>p.key===rk);if(exact.length===1)return exact;
    if(parts.length>=2&&parts[0].length===1){const ini=parts[0].toLowerCase(),last=E.nameKey(parts.slice(1).join(" "));
      return list.filter(p=>{const w=p.name.replace(/\./g," ").trim().split(/\s+/);return w[0][0].toLowerCase()===ini&&E.nameKey(w.slice(1).join(" "))===last;});}
    return exact;};
  let m=tryList(teamPlayers);if(m.length===1)return{p:m[0],ok:true};
  if(m.length>1)return{p:null,ok:false,amb:m,why:`matches ${m.length} players on ${teamCode}: ${m.map(x=>x.name).join(" / ")}`};
  const o=tryList(allPlayers);if(o.length===1)return{p:o[0],ok:false,why:`listed under ${teamCode} but last played for ${o[0].team}`};
  return{p:null,ok:false,why:"no player by that name in the box scores"};
}

/* ---------- NBA ---------- */
function buildNBA(){
  const now=new Date(TODAY+"T12:00:00");const endYear=now.getMonth()>=8?now.getFullYear()+1:now.getFullYear();
  const seasons=[];for(let y=endYear-5;y<=endYear;y++)seasons.push(y);
  const BASE="https://github.com/sportsdataverse/sportsdataverse-data/releases/download";
  const rows=[],teamGame=new Map();const games=[];
  for(const y of seasons){
    const pb=get(`${BASE}/espn_nba_player_boxscores/player_box_${y}.csv`,`nba_pb_${y}.csv`,{optional:y===endYear?false:true});
    if(pb){const t=readCSV(pb);const C=n=>col(t,n);
      const c={gid:C("game_id"),st:C("season_type"),date:C("game_date"),id:C("athlete_id"),name:C("athlete_display_name"),pos:C("athlete_position_abbreviation"),tm:C("team_abbreviation"),opp:C("opponent_team_abbreviation"),ha:C("home_away"),min:C("minutes"),pts:C("points"),reb:C("rebounds"),ast:C("assists"),fg3m:C("three_point_field_goals_made"),stl:C("steals"),blk:C("blocks"),tov:C("turnovers"),dnp:C("did_not_play"),ts:C("team_score")};
      for(const r of t.rows){const st=r[c.st];if(st!=="2"&&st!=="3")continue;
        const tm=E.team("NBA",r[c.tm]);if(!NBA30.has(tm)||!NBA30.has(E.team("NBA",r[c.opp])))continue;const k=r[c.gid]+"|"+tm;
        if(!teamGame.has(k))teamGame.set(k,{score:+r[c.ts],sum:0,date:r[c.date]});
        if(r[c.dnp]==="true"||r[c.dnp]==="TRUE"||r[c.min]===""||+r[c.min]===0)continue;
        teamGame.get(k).sum+=+r[c.pts]||0;
        rows.push({id:"n"+r[c.id],name:r[c.name],pos:r[c.pos],team:tm,opp:E.team("NBA",r[c.opp]),date:r[c.date],ha:r[c.ha]==="home"?1:0,min:Math.round(+r[c.min]),
          pts:n0(r[c.pts]),reb:n0(r[c.reb]),ast:n0(r[c.ast]),fg3m:n0(r[c.fg3m]),stl:n0(r[c.stl]),blk:n0(r[c.blk]),tov:n0(r[c.tov]),post:st==="3"?1:0,gid:r[c.gid]});}
    }
    const sc=get(`${BASE}/espn_nba_schedules/nba_schedule_${y}.csv`,`nba_sch_${y}.csv`,{optional:y!==endYear});
    if(sc){const t=readCSV(sc);const C=n=>col(t,n);
      const c={id:C("id"),st:C("season_type"),date:C("game_date"),dt:C("game_date_time"),h:C("home_abbreviation"),a:C("away_abbreviation"),hs:C("home_score"),as:C("away_score"),done:C("status_type_completed"),stn:C("status_type_name"),neu:C("neutral_site")};
      for(const r of t.rows){const st=r[c.st];if(st!=="2"&&st!=="3")continue;
        if(!NBA30.has(E.team("NBA",r[c.h]))||!NBA30.has(E.team("NBA",r[c.a])))continue;
        games.push({season:y,id:r[c.id],date:r[c.date],dt:r[c.dt],home:E.team("NBA",r[c.h]),away:E.team("NBA",r[c.a]),hs:n0(r[c.hs]),as:n0(r[c.as]),done:r[c.done]==="true"||r[c.done]==="TRUE",status:r[c.stn],neutral:r[c.neu]==="true"||r[c.neu]==="TRUE"?1:0,post:st==="3"?1:0});}
    }
  }
  log(`\n## NBA\n- Seasons loaded: ${seasons.join(", ")} · ${rows.length} player-games · ${games.length} schedule rows`);
  // internal check: player points add up to the team score
  let bad=[];teamGame.forEach((v,k)=>{if(Number.isFinite(v.score)&&v.score>0&&v.sum!==v.score)bad.push(`${k.split("|")[1]} ${v.date}: players ${v.sum} vs team ${v.score}`);});
  log(`- Box-score sum check: ${teamGame.size-bad.length}/${teamGame.size} team-games add up${bad.length?"; mismatches: "+bad.slice(0,10).join("; "):""}`);
  return finishLeague("NBA",rows,games,bad);
}

/* ---------- NFL ---------- */
function buildNFL(){
  const now=new Date(TODAY+"T12:00:00");const cur=now.getMonth()>=7?now.getFullYear():now.getFullYear()-1;
  const seasons=[];for(let y=cur-10;y<=cur;y++)seasons.push(y);
  const BASE="https://github.com/nflverse/nflverse-data/releases/download";
  const gfile=get(`${BASE}/schedules/games.csv`,"nfl_games.csv");const gt=readCSV(gfile);const G=n=>col(gt,n);
  const gc={id:G("game_id"),season:G("season"),type:G("game_type"),week:G("week"),day:G("gameday"),time:G("gametime"),a:G("away_team"),as:G("away_score"),h:G("home_team"),hs:G("home_score"),loc:G("location"),spread:G("spread_line"),total:G("total_line")};
  const games=[],gmap=new Map();
  for(const r of gt.rows){const s=+r[gc.season];if(s<cur-10)continue;
    const g={id:r[gc.id],season:s,week:+r[gc.week],date:r[gc.day],time:r[gc.time],home:E.team("NFL",r[gc.h]),away:E.team("NFL",r[gc.a]),hs:n0(r[gc.hs]),as:n0(r[gc.as]),post:r[gc.type]==="REG"?0:1,neutral:r[gc.loc]==="Neutral"?1:0,spread:r[gc.spread],total:r[gc.total]};
    g.done=g.hs!==""&&g.as!=="";games.push(g);gmap.set(g.id,g);}
  const rows=[];const POS=new Set(["QB","RB","WR","TE","FB"]);
  for(const y of seasons){
    const f=get(`${BASE}/stats_player/stats_player_week_${y}.csv`,`nfl_stats_${y}.csv`,{optional:y!==cur});if(!f)continue;
    const t=readCSV(f);const C=n=>col(t,n);
    const c={id:C("player_id"),name:C("player_display_name"),pos:C("position"),week:C("week"),gid:C("game_id"),tm:C("team"),opp:C("opponent_team"),cmp:C("completions"),att:C("attempts"),py:C("passing_yards"),ptd:C("passing_tds"),int:C("passing_interceptions"),car:C("carries"),ry:C("rushing_yards"),rec:C("receptions"),recy:C("receiving_yards")};
    for(const r of t.rows){if(!POS.has(r[c.pos]))continue;const g=gmap.get(r[c.gid]);if(!g)continue;const tm=E.team("NFL",r[c.tm]);
      rows.push({id:"f"+r[c.id],name:r[c.name],pos:r[c.pos],team:tm,opp:E.team("NFL",r[c.opp]),date:g.date,ha:g.home===tm?1:0,min:"",week:+r[c.week],
        pass_yds:n0(r[c.py]),pass_td:n0(r[c.ptd]),completions:n0(r[c.cmp]),pass_att:n0(r[c.att]),ints:n0(r[c.int]),rush_yds:n0(r[c.ry]),rush_att:n0(r[c.car]),rec:n0(r[c.rec]),rec_yds:n0(r[c.recy]),post:g.post,gid:g.id});}
  }
  log(`\n## NFL\n- Seasons loaded: ${seasons[0]}–${cur} · ${rows.length} player-games · ${games.length} games`);
  // official injury report for the current week, if published yet
  const inj=get(`${BASE}/injuries/injuries_${cur}.csv`,`nfl_inj_${cur}.csv`,{optional:true});
  return finishLeague("NFL",rows,games,[],inj);
}

/* ---------- common: slate, checks, injuries, model, docs ---------- */
function finishLeague(lg,rows,games,sumMismatch,nflInjFile){
  const flags=[];
  // slate
  let slate;
  if(lg==="NBA")slate=games.filter(g=>g.date===TODAY).map(g=>({id:"g"+g.id,away:g.away,home:g.home,start:g.dt,time:fmtTime(g.dt),status:g.status,neutral:g.neutral}));
  else{const end=addDays(TODAY,6);slate=games.filter(g=>!g.done&&g.date>=TODAY&&g.date<=end).map(g=>({id:g.id,away:g.away,home:g.home,date:g.date,time:fmtNflTime(g.date,g.time),status:"scheduled",neutral:g.neutral,week:g.week,
      spread:g.spread!==""&&g.spread!=="NA"?(+g.spread>0?`${g.home} -${+g.spread}`:+g.spread<0?`${g.away} -${-g.spread}`:"PK"):"",total:g.total&&g.total!=="NA"?String(g.total):"",lineSrc:"nflverse (closing-line feed)"}));}
  log(`- Slate: ${slate.length} games${lg==="NFL"?" in the next 7 days":" on "+TODAY}: ${slate.map(g=>g.away+"@"+g.home).join(", ")||"none"}`);

  const P=byPlayer(rows);
  const info=new Map();P.forEach((a,id)=>info.set(id,{id,name:a[0].name,pos:a[0].pos||"",team:a[0].team,key:E.nameKey(a[0].name),last:a[0].date}));
  // freshness: every completed game in the schedule should be in the box data
  const haveGame=new Set(rows.map(r=>r.date+"|"+r.team));
  const recentDone=games.filter(g=>g.done&&g.date<TODAY&&g.date>=addDays(TODAY,lg==="NBA"?-4:-10));
  const missing=[];recentDone.forEach(g=>{[g.home,g.away].forEach(t=>{if(!haveGame.has(g.date+"|"+t))missing.push(`${t} ${g.date}`);});});
  const staleTeams=new Set(missing.map(m=>m.split(" ")[0]));
  log(`- Freshness: ${recentDone.length} recent completed games checked; ${missing.length?"MISSING from box data: "+missing.join(", "):"all present"}`);
  // independent cross-check vs a second feed (final scores)
  const xc=(XC&&XC[lg])||[];const xres=[];
  xc.forEach(x=>{const a=E.team(lg,x.away),h=E.team(lg,x.home);const g=games.find(z=>z.done&&z.away===a&&z.home===h&&Math.abs(dayDiff(z.date,x.date))<=1);
    if(!g)xres.push({game:`${a}@${h} ${x.date}`,ok:false,why:"not found in data yet"});
    else if(+g.as!==+x.away_score||+g.hs!==+x.home_score)xres.push({game:`${a}@${h} ${x.date}`,ok:false,why:`data ${g.as}-${g.hs} vs check feed ${x.away_score}-${x.home_score}`});
    else xres.push({game:`${a}@${h} ${x.date}`,ok:true});});
  const xbad=xres.filter(x=>!x.ok);
  log(`- Second-feed score check: ${xres.length?`${xres.length-xbad.length}/${xres.length} games match`+(xbad.length?"; "+xbad.map(x=>x.game+" ("+x.why+")").join("; "):""):"not provided this run"}`);
  xbad.forEach(x=>{const [m]=x.game.split(" ");m.split("@").forEach(t=>staleTeams.add(t));});

  // injuries / lineups
  const slateTeams=new Set(slate.flatMap(g=>[g.away,g.home]));
  // current season = the latest season that has started; props only for players who have played for this team in it
  const started=games.filter(g=>g.date<=TODAY);const curSeason=Math.max(...started.map(g=>g.season));
  const curSeasonStart=started.filter(g=>g.season===curSeason).reduce((m,g)=>g.date<m?g.date:m,"9999");
  log(`- Current season starts ${curSeasonStart}; props only for players with a game for their team since then`);
  const allCur=[...info.values()].filter(p=>p.last>=addDays(TODAY,-420));
  const status=new Map(),injList=[],lineup={},gameLines={};let injSource="none";
  if(ESPN.ok[lg]){
    injSource="ESPN injury feed (read "+new Date().toLocaleString("en-US",{timeZone:"America/New_York",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})+" ET)";
    const NICK=lg==="NBA"?nbaTeamFrom:(s=>nflTeamFrom(s));
    ESPN.inj[lg].forEach(x=>{const code=x.team?E.team(lg,x.team):NICK(x.teamName);const st=statusNorm(/day.?to.?day/i.test(x.status)?"GTD":/injured reserve|^ir$|pup|nfi/i.test(x.status)?"Out":x.status);if(!st)return;
      let p=null,ok=false,why="";
      if(lg==="NBA"&&x.id&&info.get("n"+x.id)){p=info.get("n"+x.id);ok=p.team===code;why=ok?"":`listed under ${code} but last played for ${p.team}`;}
      else{const tp=allCur.filter(q=>q.team===code);const m=matchName(x.name,code,tp,allCur);p=m.p;ok=m.ok;why=m.why||"";
        if(m.amb)m.amb.forEach(c=>{const s=status.get(c.id)||{};s.ambiguous=`ESPN lists "${x.name}" as ${st} and it could be this player`;s.verified=false;status.set(c.id,s);});}
      injList.push({team:code,listed:x.name,status:st,player:p?p.name:null,verified:ok,why,detail:x.detail});
      if(p){const s=status.get(p.id)||{};s.status=st;s.verified=ok;s.src="ESPN";status.set(p.id,s);}});
  } else if(lg==="NBA"&&RW&&Array.isArray(RW.games)){
    injSource="Rotowire NBA lineups"+(RW.fetchedAt?` (read ${RW.fetchedAt})`:"");
    RW.games.forEach(g=>{const away=nbaTeamFrom(g.away),home=nbaTeamFrom(g.home);if(g.spread||g.total)gameLines[away+"@"+home]={spread:g.spread||"",total:g.total||""};
      (g.teams||[]).forEach(T=>{const code=nbaTeamFrom(T.team);lineup[code]=T.lineupStatus||"";
        const tp=allCur.filter(p=>p.team===code);
        (T.starters||[]).forEach(nm=>{const m=matchName(nm,code,tp,allCur);if(m.p&&m.ok){const s=status.get(m.p.id)||{};s.starter=true;status.set(m.p.id,s);}});
        (T.mayNotPlay||[]).forEach(x=>{const st=statusNorm(x.status);const m=matchName(x.name,code,tp,allCur);
          injList.push({team:code,listed:x.name,status:st,player:m.p?m.p.name:null,verified:m.ok,why:m.ok?"":m.why});
          if(m.p){const s=status.get(m.p.id)||{};s.status=st;s.verified=m.ok;s.src="Rotowire";status.set(m.p.id,s);}
          if(m.amb)m.amb.forEach(c=>{const s=status.get(c.id)||{};s.ambiguous=`Rotowire lists "${x.name}" as ${st} and it could be this player`;s.verified=false;status.set(c.id,s);});});
      });});
  } else if(lg==="NFL"&&nflInjFile){
    const t=readCSV(nflInjFile);const C=n=>col(t,n);const c={wk:C("week"),tm:C("team"),id:C("gsis_id"),name:C("full_name"),st:C("report_status"),gt:C("game_type")};
    const wk=Math.max(0,...slate.map(g=>g.week||0));const have=t.rows.some(r=>+r[c.wk]===wk);
    if(have){injSource=`Official NFL injury report, week ${wk} (nflverse)`;
      t.rows.filter(r=>+r[c.wk]===wk).forEach(r=>{const id="f"+r[c.id];const st=statusNorm(r[c.st]);if(!st)return;const p=info.get(id);
        injList.push({team:E.team("NFL",r[c.tm]),listed:r[c.name],status:st,player:p?p.name:r[c.name],verified:!!p,why:p?"":"no stats on record"});
        if(p)status.set(id,{status:st,verified:true,src:"NFL injury report"});});}
    else injSource=`Official week ${wk} report not published in the data yet`;
  }
  const injChecked=ESPN.ok[lg]?true:lg==="NBA"?!!(RW&&RW.games):injSource.startsWith("Official NFL");
  if(args.espn&&!ESPN.ok[lg])flags.push("ESPN injury feed returned nothing this run");
  slate.forEach(g=>{const l=ESPN.lines[lg+"|"+g.away+"@"+g.home];if(l&&!gameLines[g.away+"@"+g.home])gameLines[g.away+"@"+g.home]={spread:l.spread,total:l.total,src:l.src};});
  log(`- Injuries: ${injSource}; ${injList.length} listed, ${injList.filter(x=>!x.verified).length} could not be verified against rosters${injList.filter(x=>!x.verified).length?": "+injList.filter(x=>!x.verified).map(x=>`${x.listed} (${x.team}, ${x.why})`).join("; "):""}`);
  if(!injChecked)flags.push("Injury status not verified this run");

  // model the slate
  const boardDocs=[];const defs=E.STATS[lg];let nProps=0;
  slate.forEach(g=>{
    const players=[];
    [[g.away,g.home],[g.home,g.away]].forEach(([tm,opp])=>{
      const roster=[...info.values()].filter(p=>p.team===tm&&p.last>=curSeasonStart&&P.get(p.id).some(r=>r.team===tm&&r.date>=curSeasonStart));
      roster.forEach(pi=>{
        const all=P.get(pi.id);const st=status.get(pi.id)||{};
        const stat=st.status||"Active";
        const mins=all.map(r=>E.num(r.min)).filter(Number.isFinite);
        const expMin=lg==="NBA"&&mins.length?E.wstats(mins.slice(0,5)).mean:NaN;
        const pflags=[];if(staleTeams.has(tm))pflags.push("Most recent game missing or unconfirmed in data");
        if(!injChecked)pflags.push("Injury status not verified");else if(st.ambiguous)pflags.push(st.ambiguous);else if(st.verified===false)pflags.push("Injury listing not matched to roster");
        const props=[];
        if(!/^out$/i.test(stat)){defs.forEach(def=>{const m=E.modelStat(def,all,{opp,expMin,asOf:TODAY,status:stat,unverified:!injChecked||st.verified===false});if(m){props.push(m);nProps++;}});}
        if(!props.length&&!/^out$/i.test(stat))return;
        players.push({id:pi.id,name:pi.name,pos:pi.pos,team:tm,opp,status:stat,statusSrc:st.src||"",verified:st.verified!==false,starter:!!st.starter,
          expMin:Number.isFinite(expMin)?Math.round(expMin*10)/10:null,flags:pflags.filter(Boolean),
          recent:all.slice(0,40).map(r=>compact(lg,r)),vs:all.filter(r=>r.opp===opp).slice(0,40).map(r=>compact(lg,r)),props});
      });
    });
    boardDocs.push({id:`${lg}.board.${g.id}`,body:{league:lg,kind:"board",game:g.id,players}});
  });
  log(`- Modeled ${nProps} props for ${boardDocs.reduce((s,d)=>s+d.body.players.length,0)} players`);

  // h2h (team results) within the window
  const cut=addDays(TODAY,-366*E.DEFAULT_YEARS[lg]-30);
  const h2h=games.filter(g=>g.done&&g.date>=cut).map(g=>[g.date,g.away,g.home,+g.as,+g.hs,g.post,g.neutral]).sort((a,b)=>a[0]<b[0]?-1:1);
  const h2hDocs=chunkBy(h2h,5000,"rows").map((b,i)=>({id:`${lg}.h2h.${i}`,body:{league:lg,kind:"h2h",...b}}));

  // player histories by current team, plus a search index
  const idxPlayers=[...info.values()].filter(p=>p.last>=addDays(TODAY,lg==="NBA"?-560:-800)).sort((a,b)=>a.name.localeCompare(b.name));
  const byTeam={};idxPlayers.forEach(p=>(byTeam[p.team]=byTeam[p.team]||[]).push(p));
  const teamDocs=[],index=[];
  Object.entries(byTeam).forEach(([tm,list])=>{let part=0,cur={},size=0;
    const flush=()=>{if(!Object.keys(cur).length)return;teamDocs.push({id:`${lg}.team.${tm}.${part}`,body:{league:lg,kind:"team",team:tm,players:cur}});part++;cur={};size=0;};
    list.forEach(p=>{const rws=P.get(p.id).filter(r=>r.date>=cut).map(r=>compact(lg,r));const entry={name:p.name,pos:p.pos,team:tm,rows:rws};const sz=JSON.stringify(entry).length;
      if(size+sz>200000)flush();cur[p.id]=entry;size+=sz;index.push([p.id,p.name,tm,p.pos,`${lg}.team.${tm}.${part}`,p.last]);});
    flush();});
  const meta={league:lg,kind:"meta",slateDate:TODAY,updatedAt:new Date().toISOString(),games:slate.map(g=>({...g,lineup:{away:lineup[g.away]||"",home:lineup[g.home]||""},...(gameLines[g.away+"@"+g.home]?{spread:gameLines[g.away+"@"+g.home].spread,total:gameLines[g.away+"@"+g.home].total,lineSrc:gameLines[g.away+"@"+g.home].src||"Rotowire"}:{})})),
    injuries:{source:injSource,checked:injChecked,list:injList},
    checks:{boxSum:{bad:sumMismatch.slice(0,30)},freshness:{missing},secondFeed:xres,staleTeams:[...staleTeams]},
    coverage:{seasons:lg==="NBA"?"Last 5 seasons + current":"Last 10 seasons + current",playerGames:rows.length,players:index.length,h2hGames:h2h.length},
    flags,sources:(lg==="NBA"?["ESPN box scores and schedules via sportsdataverse (GitHub)"]:["nflverse schedules, weekly player stats and official injury reports (GitHub)"]).concat(
      ESPN.ok[lg]?["ESPN injury feed (injuries)"]:lg==="NBA"&&RW?["Rotowire NBA lineups (injuries, starters, game lines)"]:[],
      args.espn?[lg==="NBA"?"ESPN scoreboard (game lines; score check, which shares ESPN as the original source)":"ESPN scoreboard (game lines; score cross-check)"]:["Sportradar final scores (cross-check)"])};
  const docs=[{id:`${lg}.meta`,body:meta},{id:`${lg}.index`,body:{league:lg,kind:"index",players:index}},...h2hDocs,...boardDocs,...teamDocs];
  return docs;
}

/* ---------- helpers ---------- */
function addDays(d,n){const x=new Date(d+"T12:00:00Z");x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);}
function dayDiff(a,b){return(new Date(a+"T12:00:00Z")-new Date(b+"T12:00:00Z"))/864e5;}
function fmtTime(dt){if(!dt)return"";const d=new Date(dt.replace(/(\.\d+)?([+-]\d{2})(\d{2})$/,"$2:$3"));if(isNaN(d))return"";return d.toLocaleTimeString("en-US",{timeZone:"America/New_York",hour:"numeric",minute:"2-digit"})+" ET";}
function fmtNflTime(date,t){if(!t)return date;const [h,m]=t.split(":").map(Number);const ap=h>=12?"PM":"AM";const wd=new Date(date+"T12:00:00Z").toLocaleDateString("en-US",{weekday:"short",timeZone:"UTC"});return `${wd} ${((h+11)%12)+1}:${String(m).padStart(2,"0")} ${ap} ET`;}
function chunkBy(arr,max,key){const out=[];for(let i=0;i<arr.length;i+=max)out.push({[key]:arr.slice(i,i+max)});if(!out.length)out.push({[key]:[]});return out;}

/* ---------- main ---------- */
const docs=[];let failed=[];
if(args.espn){const xc={NBA:loadESPN("NBA"),NFL:loadESPN("NFL")};if(!XC)XC=xc;}
for(const [lg,fn] of [["NBA",buildNBA],["NFL",buildNFL]]){
  try{docs.push(...fn());}catch(e){failed.push(lg);log(`\n## ${lg} FAILED: ${e.message}`);}
}
if(!docs.length){fs.writeFileSync(path.join(OUT,"report.md"),report.join("\n"));console.log(JSON.stringify({ok:false,failed}));process.exit(2);}
// leagues that failed keep the previous run's documents
const gen="g"+new Date().toISOString().replace(/[-:T]/g,"").slice(0,12);const coll="d_"+gen;
const written=[];const sizes=[];
docs.forEach(d=>{const s=JSON.stringify(d.body);if(s.length>250000)throw new Error(`Document too large: ${d.id} ${s.length}`);
  const f=path.join(DOCS,d.id+".json");fs.writeFileSync(f,s);written.push(d.id);sizes.push(s.length);});
const batches=[];let cur=[],bytes=0;
docs.forEach((d,i)=>{if(cur.length>=50||bytes+sizes[i]>900000){batches.push(cur);cur=[];bytes=0;}cur.push({op:"set",collection:coll,doc_id:d.id,file_path:path.join(DOCS,d.id+".json")});bytes+=sizes[i];});
if(cur.length)batches.push(cur);
// carry forward a failed league's docs from the previous run
const prevDocs=(PREV&&PREV.docs)||{};const docsByLg={NBA:[],NFL:[]};written.forEach(id=>docsByLg[id.split(".")[0]].push(id));
const leagues={};["NBA","NFL"].forEach(lg=>{if(failed.includes(lg)&&prevDocs[lg]&&PREV.leagues&&PREV.leagues[lg])leagues[lg]=PREV.leagues[lg];else if(docsByLg[lg].length)leagues[lg]={coll,docs:docsByLg[lg]};});
const pointer={gen,updatedAt:new Date().toISOString(),leagues,docs:Object.fromEntries(Object.entries(leagues).map(([k,v])=>[k,v.docs])),failed,report:report.join("\n").slice(0,60000)};
fs.writeFileSync(path.join(OUT,"pointer.json"),JSON.stringify(pointer));
if(args.site){const SD=path.join(path.resolve(args.site),"data");fs.mkdirSync(SD,{recursive:true});
  if(failed.length)log(`- Website: ${failed.join(", ")} failed this run and has no previous copy to carry; only fresh leagues are published`);
  const sp={...pointer,leagues:Object.fromEntries(Object.entries(pointer.leagues).filter(([k])=>!failed.includes(k)))};
  docs.forEach(d=>fs.copyFileSync(path.join(DOCS,d.id+".json"),path.join(SD,d.id+".json")));
  fs.writeFileSync(path.join(SD,"current.json"),JSON.stringify(sp));}
// delete the previous run's docs that are no longer referenced (they were created once, so version 1)
const keep=new Set(Object.values(leagues).flatMap(v=>v.docs.map(d=>v.coll+"/"+d)));
const dels=[];if(PREV&&PREV.leagues)Object.values(PREV.leagues).forEach(v=>v.docs.forEach(d=>{if(!keep.has(v.coll+"/"+d))dels.push({op:"delete",collection:v.coll,doc_id:d,if_version:1});}));
const delBatches=[];for(let i=0;i<dels.length;i+=50)delBatches.push(dels.slice(i,i+50));
fs.writeFileSync(path.join(OUT,"plan.json"),JSON.stringify({gen,collection:coll,batches,pointerFile:path.join(OUT,"pointer.json"),deletes:delBatches},null,1));
log(`\n## Output\n- ${docs.length} documents in ${batches.length} write batches; ${dels.length} old documents to delete`);
fs.writeFileSync(path.join(OUT,"report.md"),report.join("\n"));
console.log(JSON.stringify({ok:true,failed,gen,docs:docs.length,batches:batches.length,deleteBatches:delBatches.length}));
