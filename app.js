'use strict';

const CHART_HEX = {
  B:['F7F8E8','F4F7BE','EBF185','CAD03A','999F19','657900'],
  C:['F6ECEA','F3CBC1','EB9E8A','C96144','993D24','741501'],
  D:['F6ECE0','F4DCC0','EBBD89','CF9653','975E1B','733B00'],
  E:['F5F2E1','F5E9BF','EDD688','CFAF48','9C801F','745900']
};
const GROUPS = ['B','C','D','E'];
const SPECIES = ['Acropora muricata','Pocillopora verrucosa','Stylophora pistillata'];
const TREATMENTS = ['Short-term','Long-term','Menthol'];
const GRADE_COLORS = [[250,245,200],[245,210,110],[230,155,65],[140,175,90],[70,125,85],[30,75,65]];
const T975 = [null,12.707,4.303,3.183,2.777,2.571,2.447,2.365,2.307,2.263,2.229,2.202,2.179,2.161,2.145,2.132,2.120,2.110,2.101,2.094,2.086,2.080,2.074,2.069,2.064,2.060,2.056,2.052,2.049,2.046,2.043];

const $ = id => document.getElementById(id);
const state = {
  image:null,imageName:'',points:[],refPoints:[],tool:'polygon',fit:null,
  rows:[],result:null,predictions:[],mapCanvas:null,referenceMode:'hex_auto',group:'D'
};

const photoCanvas = $('photoCanvas');
const photoCtx = photoCanvas.getContext('2d',{willReadFrequently:false});
const mapCanvas = $('mapCanvas');
const mapCtx = mapCanvas.getContext('2d');

function hexRgb(hex){ return [0,2,4].map(i => parseInt(hex.slice(i,i+2),16)); }
function refsFor(group){ return CHART_HEX[group].map(hexRgb); }
function fmt(value,digits=2){ return Number(value).toLocaleString('de-DE',{minimumFractionDigits:digits,maximumFractionDigits:digits}); }
function finite(value){ return Number.isFinite(value); }
function mean(values){ return values.reduce((a,b)=>a+b,0)/values.length; }

function rgbToLab(rgb){
  const s = rgb.map(v=>v/255);
  const lin = s.map(v=>v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4));
  let x=lin[0]*.4124564+lin[1]*.3575761+lin[2]*.1804375;
  let y=lin[0]*.2126729+lin[1]*.7151522+lin[2]*.0721750;
  let z=lin[0]*.0193339+lin[1]*.1191920+lin[2]*.9503041;
  [x,y,z]=[x/.95047,y,z/1.08883];
  const d=6/29;
  const f=v=>v>d**3?Math.cbrt(v):v/(3*d*d)+4/29;
  const [fx,fy,fz]=[f(x),f(y),f(z)];
  return [116*fy-16,500*(fx-fy),200*(fy-fz)];
}
function deltaE(a,b){ return Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]); }

function toast(text){
  const old=document.querySelector('.toast'); if(old) old.remove();
  const el=document.createElement('div'); el.className='toast'; el.textContent=text; document.body.appendChild(el);
  setTimeout(()=>el.remove(),2400);
}
function message(title,html){ $('messageTitle').textContent=title; $('messageBody').innerHTML=html; $('messageDialog').showModal(); }

function parseCSV(text){
  const lines=text.replace(/\r/g,'').trim().split('\n');
  const headers=lines.shift().split(';').map(v=>v.replace(/^"|"$/g,''));
  return lines.map(line=>{
    const values=line.split(';').map(v=>v.replace(/^"|"$/g,''));
    const row=Object.fromEntries(headers.map((h,i)=>[h,values[i]??'']));
    for(const key of ['R','G','B','Symb_per_cm2','Chl_per_cm2']){
      const v=(row[key]||'').replace(',','.'); row[key]=(v==='NA'||v==='')?NaN:Number(v);
    }
    return row;
  });
}

async function loadCalibration(){
  try{
    const response=await fetch('assets/CHROMA.csv');
    if(!response.ok) throw new Error('HTTP '+response.status);
    state.rows=parseCSV(await response.text());
    $('calibrationStatus').textContent=`Ferrara-Daten bereit: ${state.rows.length} Referenzzeilen`;
  }catch(error){
    $('calibrationStatus').textContent='Ferrara-Daten nicht verfügbar';
    console.error(error);
  }
}

function fitReference(species,treatment,target){
  const rows=state.rows.filter(r=>r.Species_name===species&&r.Bleaching===treatment&&finite(r[target])&&finite(r.R));
  if(rows.length<3) return null;
  const x=rows.map(r=>r.R), y=rows.map(r=>r[target]), xm=mean(x), ym=mean(y);
  const sxx=x.reduce((s,v)=>s+(v-xm)**2,0); if(!sxx) return null;
  const slope=x.reduce((s,v,i)=>s+(v-xm)*(y[i]-ym),0)/sxx;
  const intercept=ym-slope*xm;
  const residual=y.map((v,i)=>v-(intercept+slope*x[i]));
  const sse=residual.reduce((s,v)=>s+v*v,0), sst=y.reduce((s,v)=>s+(v-ym)**2,0);
  return {species,treatment,target,n:x.length,intercept,slope,R2:sst?1-sse/sst:NaN,
    residual_sd:Math.sqrt(sse/(x.length-2)),xmean:xm,sxx,R_min:Math.min(...x),R_max:Math.max(...x)};
}

function predictReference(model,R){
  const estimate=model.intercept+model.slope*R, df=model.n-2, t=T975[Math.min(df,30)];
  const width=t*model.residual_sd*Math.sqrt(1+1/model.n+(R-model.xmean)**2/model.sxx);
  return {...model,estimate,lower95:estimate-width,upper95:estimate+width,in_range:R>=model.R_min&&R<=model.R_max};
}

function ferraraPredictions(R,species){
  if(!SPECIES.includes(species)||!state.rows.length) return [];
  const out=[];
  for(const treatment of TREATMENTS){
    for(const target of ['Symb_per_cm2','Chl_per_cm2']){
      const model=fitReference(species,treatment,target); if(model) out.push(predictReference(model,R));
    }
  }
  return out;
}

function resizeCanvas(){
  const box=$('canvasShell').getBoundingClientRect(), dpr=Math.min(window.devicePixelRatio||1,2);
  const w=Math.max(1,Math.round(box.width*dpr)),h=Math.max(1,Math.round(box.height*dpr));
  if(photoCanvas.width!==w||photoCanvas.height!==h){photoCanvas.width=w;photoCanvas.height=h;drawPhoto();}
}

function drawPhoto(){
  const dpr=Math.min(window.devicePixelRatio||1,2), cw=photoCanvas.width/dpr,ch=photoCanvas.height/dpr;
  photoCtx.setTransform(dpr,0,0,dpr,0,0); photoCtx.clearRect(0,0,cw,ch);
  if(!state.image){state.fit=null;return;}
  const scale=Math.min(cw/state.image.naturalWidth,ch/state.image.naturalHeight);
  const w=state.image.naturalWidth*scale,h=state.image.naturalHeight*scale,x=(cw-w)/2,y=(ch-h)/2;
  state.fit={x,y,scale,w,h}; photoCtx.drawImage(state.image,x,y,w,h);
  if(state.points.length){
    photoCtx.beginPath(); photoCtx.moveTo(x+state.points[0][0]*scale,y+state.points[0][1]*scale);
    for(const [px,py] of state.points.slice(1)) photoCtx.lineTo(x+px*scale,y+py*scale);
    if(state.points.length>=3) photoCtx.closePath();
    photoCtx.lineWidth=3;photoCtx.strokeStyle='#ff4d69';photoCtx.stroke();
    photoCtx.fillStyle='#ff4d69';
    for(const [px,py] of state.points){photoCtx.beginPath();photoCtx.arc(x+px*scale,y+py*scale,4,0,Math.PI*2);photoCtx.fill();}
  }
  state.refPoints.forEach(([px,py],i)=>{
    const sx=x+px*scale,sy=y+py*scale;photoCtx.beginPath();photoCtx.arc(sx,sy,8,0,Math.PI*2);
    photoCtx.fillStyle='#062d3d';photoCtx.fill();photoCtx.lineWidth=3;photoCtx.strokeStyle='#50ffff';photoCtx.stroke();
    photoCtx.fillStyle='#fff';photoCtx.font='bold 12px sans-serif';photoCtx.textAlign='center';photoCtx.textBaseline='middle';photoCtx.fillText(String(i+1),sx,sy+.5);
  });
}

function updateSelectionStatus(){
  const ref=state.referenceMode==='photo'?` · Kartenfelder: ${state.refPoints.length}/6`:'';
  $('selectionStatus').textContent=`Polygon: ${state.points.length} Punkte${ref}`;
  drawPhoto();
}

function setTool(tool){
  if(tool==='reference'&&state.referenceMode!=='photo'){
    toast('Im HEX-Modus sind die Kartenfarben bereits hinterlegt.'); return;
  }
  state.tool=tool;
  $('referenceTool').classList.toggle('active',tool==='reference');
  $('polygonTool').classList.toggle('active',tool==='polygon');
}

function canvasPoint(event){
  if(!state.fit) return null;
  const rect=photoCanvas.getBoundingClientRect(),cx=event.clientX-rect.left,cy=event.clientY-rect.top;
  const {x,y,scale,w,h}=state.fit; if(cx<x||cy<y||cx>x+w||cy>y+h) return null;
  return [Math.max(0,Math.min(state.image.naturalWidth-1,Math.round((cx-x)/scale))),Math.max(0,Math.min(state.image.naturalHeight-1,Math.round((cy-y)/scale)))];
}

photoCanvas.addEventListener('pointerdown',event=>{
  if(!state.image) return; event.preventDefault(); const p=canvasPoint(event); if(!p)return;
  if(state.tool==='reference'){
    if(state.referenceMode!=='photo'){toast('Bitte zuerst „Sechs Kartenfelder im Foto“ wählen.');return;}
    if(state.refPoints.length>=6){toast('Alle sechs Kartenpunkte sind gesetzt.');return;}
    state.refPoints.push(p);
    if(state.refPoints.length===6){setTool('polygon');toast('Sechs Felder gesetzt – jetzt die Koralle umranden.');}
  }else state.points.push(p);
  state.result=null; updateSelectionStatus();
},{passive:false});

function loadImageFromURL(url,name){
  return new Promise((resolve,reject)=>{
    const img=new Image(); img.onload=()=>{
      state.image=img;state.imageName=name;state.points=[];state.refPoints=[];state.result=null;
      $('emptyState').classList.add('hidden');$('photoInfo').textContent=`${name} · ${img.naturalWidth} × ${img.naturalHeight} px`;
      $('resultsSection').hidden=true;setTool(state.referenceMode==='photo'?'reference':'polygon');updateSelectionStatus();resolve();
    };img.onerror=()=>reject(new Error('Das Bildformat konnte nicht geöffnet werden.'));img.src=url;
  });
}

async function loadFile(file){
  if(!file)return; const url=URL.createObjectURL(file);
  try{await loadImageFromURL(url,file.name);}catch(error){message('Bild nicht geöffnet',`<p>${error.message}</p><p>Bitte JPEG oder PNG verwenden.</p>`);}finally{setTimeout(()=>URL.revokeObjectURL(url),5000);}
}

function originalImageData(){
  const canvas=document.createElement('canvas'); canvas.width=state.image.naturalWidth;canvas.height=state.image.naturalHeight;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(state.image,0,0);return {canvas,ctx,data:ctx.getImageData(0,0,canvas.width,canvas.height)};
}
function polygonMask(width,height,points){
  const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d',{willReadFrequently:true});
  ctx.fillStyle='#fff';ctx.beginPath();ctx.moveTo(points[0][0],points[0][1]);for(const p of points.slice(1))ctx.lineTo(p[0],p[1]);ctx.closePath();ctx.fill();
  return ctx.getImageData(0,0,width,height).data;
}
function samplePatch(data,width,height,x,y,radius=4){
  const sum=[0,0,0];let n=0;
  for(let yy=Math.max(0,y-radius);yy<=Math.min(height-1,y+radius);yy++)for(let xx=Math.max(0,x-radius);xx<=Math.min(width-1,x+radius);xx++){
    const i=(yy*width+xx)*4;sum[0]+=data[i];sum[1]+=data[i+1];sum[2]+=data[i+2];n++;
  }
  return sum.map(v=>v/n);
}

function analysePixels(imageData,maskData,refs,group,selection,source,votes){
  const {width,height,data}=imageData, labs=refs.map(rgbToLab);
  let n=0,sR=0,sG=0,sB=0,sR2=0,sG2=0,sB2=0,distanceSum=0,scoreSum=0;
  const counts=[0,0,0,0,0,0], map=new ImageData(new Uint8ClampedArray(data),width,height);
  for(let i=0;i<data.length;i+=4){
    if(maskData[i]===0) continue;
    const rgb=[data[i],data[i+1],data[i+2]],lab=rgbToLab(rgb);let best=0,bestD=Infinity;
    for(let k=0;k<6;k++){const d=deltaE(lab,labs[k]);if(d<bestD){bestD=d;best=k;}}
    const grade=best+1;n++;scoreSum+=grade;counts[best]++;distanceSum+=bestD;
    sR+=rgb[0];sG+=rgb[1];sB+=rgb[2];sR2+=rgb[0]**2;sG2+=rgb[1]**2;sB2+=rgb[2]**2;
    const color=GRADE_COLORS[best];map.data[i]=color[0];map.data[i+1]=color[1];map.data[i+2]=color[2];map.data[i+3]=255;
  }
  if(!n) throw new Error('Die ausgewählte Korallenfläche enthält keine Pixel.');
  const meanRgb=[sR/n,sG/n,sB/n];
  const sd=[Math.sqrt(Math.max(0,(sR2-sR*sR/n)/(Math.max(1,n-1)))),Math.sqrt(Math.max(0,(sG2-sG*sG/n)/(Math.max(1,n-1)))),Math.sqrt(Math.max(0,(sB2-sB*sB/n)/(Math.max(1,n-1))))];
  const gradePercent=counts.map(v=>100*v/n),meanScore=scoreSum/n;
  const sep=Math.min(...labs.slice(1).map((v,i)=>deltaE(v,labs[i])));
  const result={n_pixels:n,rgb_mean:meanRgb,rgb_sd:sd,grade_percent:gradePercent,mean_score:meanScore,
    bleaching_area_percent:gradePercent.slice(0,3).reduce((a,b)=>a+b,0),dark_area_percent:gradePercent.slice(3).reduce((a,b)=>a+b,0),
    health_color_category:meanScore>3?'gesund nach Score-Regel':'bleicheverdächtig nach Score-Regel',
    mean_deltaE76:distanceSum/n,min_reference_deltaE76:sep,group,group_selection:selection,reference_source:source,
    reference_rgb:refs,mapImageData:map};
  if(votes){
    result.group_vote_percent=Object.fromEntries(GROUPS.map((g,i)=>[g,100*votes[i]/n]));
    const allRefs=GROUPS.flatMap(refsFor), allLabs=allRefs.map(rgbToLab),mLab=rgbToLab(meanRgb);
    result.nearest_mean_colors=allLabs.map((v,i)=>({field:GROUPS[Math.floor(i/6)]+String(i%6+1),deltaE76:deltaE(v,mLab)})).sort((a,b)=>a.deltaE76-b.deltaE76).slice(0,3);
  }
  return result;
}

function analyse(){
  if(!state.image){message('Foto fehlt','<p>Bitte zuerst ein Korallenfoto oder das Beispielfoto öffnen.</p>');return;}
  if(state.points.length<3){message('Polygon unvollständig','<p>Bitte mindestens drei Punkte rund um die Koralle setzen.</p>');return;}
  if(state.referenceMode==='photo'&&state.refPoints.length!==6){message('Kartenfelder fehlen','<p>Im Foto-Modus müssen sechs Felder derselben Reihe in der Reihenfolge 1 bis 6 markiert werden.</p>');return;}
  $('analyseBtn').disabled=true;$('analyseBtn').textContent='Auswertung läuft …';
  setTimeout(()=>{
    try{
      const original=originalImageData(),mask=polygonMask(original.data.width,original.data.height,state.points);
      let group=state.group,refs,selection,source,votes=null;
      if(state.referenceMode==='photo'){
        refs=state.refPoints.map(([x,y])=>samplePatch(original.data.data,original.data.width,original.data.height,x,y));
        selection='manuell';source='Sechs Kartenfelder aus demselben Foto';
      }else{
        votes=[0,0,0,0];const candidate=[];
        GROUPS.forEach((g,gi)=>refsFor(g).forEach((rgb,si)=>{if(si>=2)candidate.push({gi,lab:rgbToLab(rgb)});}));
        for(let i=0;i<original.data.data.length;i+=4){
          if(mask[i]===0)continue;const lab=rgbToLab([original.data.data[i],original.data.data[i+1],original.data.data[i+2]]);let best=null,bestD=Infinity;
          for(const c of candidate){const d=deltaE(lab,c.lab);if(d<bestD){bestD=d;best=c;}} votes[best.gi]++;
        }
        if(state.referenceMode==='hex_auto') group=GROUPS[votes.indexOf(Math.max(...votes))];
        refs=refsFor(group);selection=state.referenceMode==='hex_auto'?'automatisch':'manuell';source='Hinterlegte HEX-Werte (als sRGB interpretiert)';
      }
      const result=analysePixels(original.data,mask,refs,group,selection,source,votes);
      result.coral_name=$('coralName').value.trim()||'unbekannt';
      result.color_processing='Browser-Canvas in sRGB-Ausgabe; ICC-Umwandlung erfolgt durch Safari. Kein zusätzlicher Weißabgleich.';
      state.group=group;$('referenceGroup').value=group;
      const species=$('species').value;state.predictions=ferraraPredictions(result.rgb_mean[0],species);state.result=result;state.mapCanvas=original.canvas;
      renderResults(result,state.predictions,species);
    }catch(error){console.error(error);message('Auswertung nicht möglich',`<p>${error.message}</p>`);}
    finally{$('analyseBtn').disabled=false;$('analyseBtn').textContent='Korallenfarbe auswerten';}
  },60);
}

function renderResults(result,predictions,species){
  $('resultsSection').hidden=false;$('resultTimestamp').textContent=new Date().toLocaleString('de-DE');
  $('meanScore').textContent=fmt(result.mean_score,2);$('chosenGroup').textContent=`Reihe ${result.group}`;
  $('rgbMean').textContent=result.rgb_mean.map(v=>fmt(v,1)).join(' · ');$('pixelDetails').textContent=`${result.n_pixels.toLocaleString('de-DE')} Pixel · SD ${result.rgb_sd.map(v=>fmt(v,1)).join(' / ')}`;
  $('deltaE').textContent=fmt(result.mean_deltaE76,2);
  const hb=$('healthBadge');hb.textContent=result.health_color_category;hb.classList.toggle('warning',result.mean_score<=3);
  if(result.group_vote_percent){$('groupDetails').textContent=`${result.group_selection}; Stimmen B ${fmt(result.group_vote_percent.B,1)} %, C ${fmt(result.group_vote_percent.C,1)} %, D ${fmt(result.group_vote_percent.D,1)} %, E ${fmt(result.group_vote_percent.E,1)} %`;}
  else $('groupDetails').textContent=`${result.group_selection}; ${result.reference_source}`;
  $('stageBars').innerHTML=result.grade_percent.map((v,i)=>`<div class="stage-row"><span>Stufe ${i+1}</span><div class="stage-track"><div class="stage-fill" style="width:${Math.max(0,Math.min(100,v))}%;background:rgb(${GRADE_COLORS[i].join(',')})"></div></div><span class="stage-value">${fmt(v,2)} %</span></div>`).join('');
  $('lightArea').textContent=fmt(result.bleaching_area_percent,2)+' %';$('darkArea').textContent=fmt(result.dark_area_percent,2)+' %';
  mapCanvas.width=result.mapImageData.width;mapCanvas.height=result.mapImageData.height;mapCtx.putImageData(result.mapImageData,0,0);
  renderFerrara(predictions,species);$('reportText').value=reportText(result,predictions,species);
  $('ferraraDownloadBtn').disabled=!predictions.length;
  $('resultsSection').scrollIntoView({behavior:'smooth',block:'start'});
}

function renderFerrara(predictions,species){
  const box=$('ferraraResults');
  if(!predictions.length){
    $('ferraraIntro').textContent=species?'Für diese Auswahl konnte kein Modell berechnet werden.':'Keine Referenzart ausgewählt – bei Dipsastraea bleibt es beim Kartenvergleich.';
    box.innerHTML='<div class="notice">Biologische Schätzwerte werden nur für die drei experimentell untersuchten Arten ausgegeben.</div>';return;
  }
  $('ferraraIntro').textContent=`Explorative Übertragung auf ${species}; Behandlungen werden getrennt dargestellt.`;
  box.innerHTML=TREATMENTS.map(treatment=>{
    const rows=predictions.filter(p=>p.treatment===treatment);
    const items=rows.map(p=>{
      const sym=p.target==='Symb_per_cm2',factor=sym?1e6:1,unit=sym?'Mio. Zellen/cm²':'µg Chlorophyll/cm²';
      return `<div><div class="estimate">${fmt(p.estimate/factor,3)} ${unit}</div><div class="interval">95%-Vorhersageintervall: ${fmt(p.lower95/factor,3)} bis ${fmt(p.upper95/factor,3)}</div><div class="model-meta"><span>n = ${p.n}</span><span>R² = ${fmt(p.R2,3)}</span></div>${!p.in_range?'<div class="model-warning">R außerhalb der Referenzdaten: Extrapolation</div>':''}${p.estimate<0?'<div class="model-warning">Negative Schätzung: biologisch nicht plausibel</div>':''}</div>`;
    }).join('');
    return `<section class="model-card"><h4>${treatment}</h4>${items||'<p>Keine Referenzwerte.</p>'}</section>`;
  }).join('');
}

function reportText(result,predictions,species){
  const [R,G,B]=result.rgb_mean,sd=result.rgb_sd,lines=[
    'KORALLEN: KARTENVERGLEICH UND REFERENZMODELLE','Safari-Web-App; lokale MINT-Umsetzung ohne trainierte KI. Keine Original-CRCA-Software.',
    'Korallenname: '+result.coral_name,'Foto: '+state.imageName,'Referenzquelle: '+result.reference_source,'Farbverarbeitung: '+result.color_processing,
    `Referenzreihe: ${result.group} (${result.group_selection})`,`Pixel: ${result.n_pixels}`,`R = ${R.toFixed(2)}\nG = ${G.toFixed(2)}\nB = ${B.toFixed(2)}`,
    `Pixel-SD: R=${sd[0].toFixed(2)}, G=${sd[1].toFixed(2)}, B=${sd[2].toFixed(2)}`,'','CORALWATCH-VERGLEICH (MINT-Auswertung)',
    `Mittlerer Farbscore: ${result.mean_score.toFixed(2)} / 6`,`Farbbasierte Einstufung: ${result.health_color_category}`,
    'Regel: mittlerer Score >3 = gesund; <=3 = bleicheverdächtig.','Dies ist eine Unterrichtsregel zur Farbe, keine umfassende Gesundheitsdiagnose.'
  ];
  if(result.group_vote_percent){
    lines.push('Stimmenanteile der Reihen (keine Art-/Gesundheitswahrscheinlichkeit): '+GROUPS.map(g=>`${g}: ${result.group_vote_percent[g].toFixed(1)} %`).join(', '));
    lines.push('Nächste Felder zum RGB-Mittelwert: '+result.nearest_mean_colors.map(v=>`${v.field} (Lab-Abstand ${v.deltaE76.toFixed(2)})`).join(', '));
    lines.push('HEX-Vergleich nutzt digitale sRGB-Referenzen. Foto-Licht kann die Zuordnung verschieben.');
  }
  result.grade_percent.forEach((v,i)=>lines.push(`Stufe ${i+1}: ${v.toFixed(2)} % der Bildfläche`));
  lines.push(`Helle Bildfläche (Stufen 1–3): ${result.bleaching_area_percent.toFixed(2)} %`,`Dunklere Bildfläche (Stufen 4–6): ${result.dark_area_percent.toFixed(2)} %`,
    'Flächenmehrheit: '+(result.bleaching_area_percent>50?'Stufen 1–3':result.dark_area_percent>50?'Stufen 4–6':'gleich verteilt'),
    'Mittelwertkategorie und Flächenmehrheit können voneinander abweichen.','Das ist ein farbbasierter Flächenanteil, kein gemessener Symbiontenverlust.',
    `Mittlerer Lab-Farbabstand: ${result.mean_deltaE76.toFixed(2)} (Delta E 76)`,`Kleinster Abstand benachbarter Kartenfelder: ${result.min_reference_deltaE76.toFixed(2)}`,
    result.min_reference_deltaE76<2?'HINWEIS: benachbarte Referenzen kaum unterscheidbar. Auswahl prüfen.':'Referenzfelder numerisch unterscheidbar.','','FERRARA-REFERENZMODELLE');
  if(!predictions.length) lines.push('Für diesen Korallennamen bzw. diese Auswahl liegt kein Ferrara-Modell vor: keine biologische Schätzung.');
  else{
    lines.push('Ausgewählte Modellart: '+species,'Explorative Übertragung auf dieses Foto. Modelle nach Behandlung getrennt.','OLS mit allen endlichen Wertepaaren, ohne Cook-Ausreißerfilter.','95%-Vorhersageintervall gilt für das Referenzmodell. Aufnahmefehler fehlen.');
    for(const p of predictions){const factor=p.target==='Symb_per_cm2'?1e6:1,unit=factor>1?'Millionen Zellen/cm²':'µg Chlorophyll/cm²';lines.push(`${p.treatment}: ${(p.estimate/factor).toFixed(3)} ${unit} [${(p.lower95/factor).toFixed(3)} … ${(p.upper95/factor).toFixed(3)}], n=${p.n}, R²=${p.R2.toFixed(3)}`);if(!p.in_range)lines.push('  R außerhalb der Referenzdaten: Extrapolation.');if(p.estimate<0)lines.push('  Negative Schätzung: biologisch unplausibel, Modell hier nicht verwenden.');}
    lines.push('Menthol: kein Chlorophyllmodell, da keine Chlorophyllreferenzwerte.');
  }
  lines.push('','KI IM ORIGINAL CORAL-CRCA','CoralSCOP/SAM segmentiert Korallen. YOLOv11n-OBB erkennt Kartenfelder.','Clustering und Lab-Farbvergleich ordnen Pixel den Kartenstufen zu.','Hier ersetzt ein manuelles Polygon die KI-Segmentierung.','HEX-Reihenwahl und Lab-Vergleich sind feste Rechenregeln ohne trainierte KI.','Safari vereinheitlicht die Canvas-Ausgabe in sRGB; Kontrast und Weißabgleich werden nicht angepasst.');
  return lines.join('\n');
}

function safeName(){const name=($('coralName').value||'Koralle').trim().replace(/[^a-zA-Z0-9äöüÄÖÜß_-]+/g,'_');return `${name}_${new Date().toISOString().replace(/[:.]/g,'-')}`;}
function downloadBlob(blob,filename){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);}
function downloadText(text,filename,type='text/plain;charset=utf-8'){downloadBlob(new Blob(['\ufeff'+text],{type}),filename);}
function csvEscape(v){const s=String(v??'');return `"${s.replaceAll('"','""')}"`;}

function exportStageCSV(){const lines=['Stufe;Flaechenanteil_Prozent'];state.result.grade_percent.forEach((v,i)=>lines.push(`${i+1};${String(v).replace('.',',')}`));downloadText(lines.join('\n'),safeName()+'_Stufen.csv','text/csv;charset=utf-8');}
function exportFerraraCSV(){if(!state.predictions.length)return;const keys=['species','treatment','target','n','intercept','slope','R2','residual_sd','R_min','R_max','estimate','lower95','upper95','in_range'];const lines=[keys.join(';'),...state.predictions.map(p=>keys.map(k=>csvEscape(p[k])).join(';'))];downloadText(lines.join('\n'),safeName()+'_Ferrara.csv','text/csv;charset=utf-8');}
function exportJSON(){
  const plain={...state.result};delete plain.mapImageData;
  Object.assign(plain,{image_name:state.imageName,image_size:[state.image.naturalWidth,state.image.naturalHeight],polygon:state.points,reference_points:state.refPoints,species:$('species').value||null,predictions:state.predictions,processing:'Browser sRGB canvas, manual mask; no contrast or white-balance correction'});
  downloadText(JSON.stringify(plain,null,2),safeName()+'.json','application/json;charset=utf-8');
}
function exportMap(){mapCanvas.toBlob(blob=>downloadBlob(blob,safeName()+'_Farbkarte.png'),'image/png');}

$('photoInput').addEventListener('change',e=>loadFile(e.target.files[0]));
$('demoBtn').addEventListener('click',()=>loadImageFromURL('assets/IMG_8824.jpeg','IMG_8824.jpeg').catch(e=>message('Beispiel fehlt',`<p>${e.message}</p>`)));
$('referenceMode').addEventListener('change',e=>{state.referenceMode=e.target.value;state.refPoints=[];$('referenceGroup').disabled=e.target.value==='hex_auto';$('groupHint').textContent=e.target.value==='hex_auto'?'Die Reihe wird aus den Stufen 3–6 ermittelt.':e.target.value==='photo'?'Diese Reihe wird im Bericht dokumentiert.':'Diese Reihe wird fest verwendet.';setTool(e.target.value==='photo'?'reference':'polygon');updateSelectionStatus();});
$('referenceGroup').addEventListener('change',e=>{state.group=e.target.value;state.result=null;});
$('species').addEventListener('change',e=>{if(e.target.value)$('coralName').value=e.target.value;});
$('referenceTool').addEventListener('click',()=>setTool('reference'));$('polygonTool').addEventListener('click',()=>setTool('polygon'));
$('undoBtn').addEventListener('click',()=>{if(state.tool==='reference'&&state.refPoints.length)state.refPoints.pop();else if(state.tool==='polygon'&&state.points.length)state.points.pop();state.result=null;updateSelectionStatus();});
$('clearPolygonBtn').addEventListener('click',()=>{state.points=[];state.result=null;setTool('polygon');updateSelectionStatus();});
$('clearRefsBtn').addEventListener('click',()=>{state.refPoints=[];state.result=null;if(state.referenceMode==='photo')setTool('reference');updateSelectionStatus();});
$('analyseBtn').addEventListener('click',analyse);
$('helpBtn').addEventListener('click',()=>$('helpDialog').showModal());
$('speciesHelpBtn').addEventListener('click',()=>message('Ferrara-Referenzmodelle','<p>Die Modelle wurden aus destruktiv bestimmten Symbiontendichten und Chlorophyllgehalten sowie RGB-Werten der drei untersuchten Arten kalibriert.</p><p>Die neue Fotoauswertung selbst ist nichtinvasiv. Die ausgegebenen biologischen Werte sind jedoch Modellschätzungen und nur bei passender Art sowie vergleichbaren Aufnahmebedingungen sinnvoll.</p>'));
$('copyReportBtn').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('reportText').value);toast('Bericht kopiert.');}catch{const t=$('reportText');t.focus();t.select();document.execCommand('copy');toast('Bericht kopiert.');}});
$('txtDownloadBtn').addEventListener('click',()=>downloadText($('reportText').value,safeName()+'_Bericht.txt'));
$('csvDownloadBtn').addEventListener('click',exportStageCSV);$('jsonDownloadBtn').addEventListener('click',exportJSON);$('ferraraDownloadBtn').addEventListener('click',exportFerraraCSV);$('mapDownloadBtn').addEventListener('click',exportMap);
window.addEventListener('resize',resizeCanvas);new ResizeObserver(resizeCanvas).observe($('canvasShell'));
window.addEventListener('online',()=>{$('offlineBadge').textContent='online · offline-fähig';});window.addEventListener('offline',()=>{$('offlineBadge').textContent='offline aktiv';});

if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.error);
$('referenceGroup').disabled=true;loadCalibration();resizeCanvas();
