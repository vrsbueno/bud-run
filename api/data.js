// Vercel Serverless Function: /api/data.js
// Integrates with Intervals.icu to fetch readiness, workouts, recent activities (last week + current week),
// monthly/weekly volumes (Mon-Sun with 01/11 in Oct and 30/11 rolled to Dec), 6-month historical volume, and PRs.

export default async function handler(req, res) {
  // Configs
  const ATHLETE_ID = process.env.INTERVALS_ATHLETE_ID || "i779517";
  const API_KEY = process.env.INTERVALS_API_KEY || "5js96v4gdskzuv3lub3g8ea51";
  const AUTH_HEADER = "Basic " + Buffer.from(`API_KEY:${API_KEY}`).toString("base64");

  // Timezone BR (America/Sao_Paulo: UTC-3)
  const now = new Date();
  const brDateStr = now.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }); // "DD/MM/YYYY"
  const brTimeStr = now.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  const [dBr, mBr, yBr] = brDateStr.split("/");
  const todayStr = `${yBr}-${mBr}-${dBr}`; // "YYYY-MM-DD"

  // Date ranges
  const past60Days = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  const next7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const oldestPastStr = past60Days.toISOString().split("T")[0];
  const newestFutureStr = next7Days.toISOString().split("T")[0];

  try {
    // 1. Fetch Wellness (Resting HR, TSB, CTL, ATL)
    const wellnessPromise = fetch(
      `https://intervals.icu/api/v1/athlete/${ATHLETE_ID}/wellness?oldest=${oldestPastStr}&newest=${todayStr}`,
      { headers: { Authorization: AUTH_HEADER } }
    ).then((r) => (r.ok ? r.json() : []));

    // 2. Fetch Activities (Past 60 days)
    const activitiesPromise = fetch(
      `https://intervals.icu/api/v1/athlete/${ATHLETE_ID}/activities?oldest=${oldestPastStr}&newest=${todayStr}`,
      { headers: { Authorization: AUTH_HEADER } }
    ).then((r) => (r.ok ? r.json() : []));

    // 3. Fetch Scheduled Events/Workouts (Today + Next 7 days)
    const eventsPromise = fetch(
      `https://intervals.icu/api/v1/athlete/${ATHLETE_ID}/events?oldest=${todayStr}&newest=${newestFutureStr}`,
      { headers: { Authorization: AUTH_HEADER } }
    ).then((r) => (r.ok ? r.json() : []));

    const [wellnessData, activitiesData, eventsData] = await Promise.all([
      wellnessPromise,
      activitiesPromise,
      eventsPromise,
    ]);

    // Parse latest wellness entry
    const wellnessArr = Array.isArray(wellnessData) ? wellnessData : [];
    const latestWellness = wellnessArr.length > 0 ? wellnessArr[wellnessArr.length - 1] : {};

    // Find latest valid restingHR (avoid fallback when today hasn't synced yet)
    const validHRRows = wellnessArr.filter((w) => w.restingHR != null && w.restingHR > 0);
    const latestHRRow = validHRRows.length > 0 ? validHRRows[validHRRows.length - 1] : null;
    const restingHR = latestHRRow ? latestHRRow.restingHR : 50;

    const recent7HR = validHRRows.slice(-7);
    const restingHRAvg = recent7HR.length > 0
      ? Math.round(recent7HR.reduce((s, w) => s + w.restingHR, 0) / recent7HR.length)
      : restingHR;

    let restingHRRef = "";
    if (latestHRRow && latestHRRow.id && latestHRRow.id !== todayStr) {
      const p = latestHRRow.id.split("-");
      restingHRRef = ` • ref. ${p[2]}/${p[1]}`;
    }
    const hrDiff = restingHR - restingHRAvg;
    const restingHROk = hrDiff < 5;
    const restingHRSub = latestHRRow
      ? (restingHROk
          ? `✓ Estável (média ${restingHRAvg} bpm)${restingHRRef}`
          : `⚠ +${hrDiff} bpm vs média (${restingHRAvg})${restingHRRef}`)
      : "Sem leitura recente do Garmin";

    const ctl = Math.round((latestWellness.ctl || 0) * 10) / 10;
    const atl = Math.round((latestWellness.atl || 0) * 10) / 10;
    const tsb = Math.round((latestWellness.tsb || 0) * 10) / 10;

    // Determine readiness form status
    let formStatus = "Ótimo";
    let formBadge = "good";
    let formNote = "Pronto para treinos intensos";
    if (tsb < -20) {
      formStatus = "Sobrecarga Alta";
      formBadge = "alert";
      formNote = "Cuidado com risco de fadiga excessiva";
    } else if (tsb < -10) {
      formStatus = "Zona de Treino";
      formBadge = "good";
      formNote = "Estímulo ideal de sobrecarga";
    } else if (tsb >= -10 && tsb <= 5) {
      formStatus = "Neutro / Equilibrado";
      formBadge = "good";
      formNote = "Boa recuperação e adaptação";
    } else if (tsb > 5) {
      formStatus = "Muito Descansado";
      formBadge = "fresh";
      formNote = "Polimento / Recuperação completa";
    }

    // Determine today's workout
    const todayEvents = Array.isArray(eventsData) 
      ? eventsData.filter((e) => e.start_date_local && e.start_date_local.startsWith(todayStr))
      : [];
    
    let todayWorkout = {
      name: "Descanso Ativo ou Regenerativo",
      description: "Sem treinos de alta intensidade agendados para hoje na planilha.",
      warmup: null,
      distance: "-",
      duration: "-"
    };

    if (todayEvents.length > 0) {
      const ev = todayEvents[0];
      let warmupText = null;

      if (ev.workout_doc && Array.isArray(ev.workout_doc.steps)) {
        const wStep = ev.workout_doc.steps.find(s => s.warmup || (s.text && s.text.toLowerCase().includes("aquec")));
        if (wStep) {
          const wDist = wStep.distance ? (wStep.distance >= 1000 ? (wStep.distance / 1000).toFixed(0) + "km" : wStep.distance + "m") : null;
          const wDur = wStep.duration ? Math.round(wStep.duration / 60) + " min" : null;
          warmupText = `Aquecimento: ${wDist || wDur || "Incluso"}`;
        }
      }

      if (!warmupText && ev.description) {
        const m = ev.description.match(/(?:-|\b)Aquecimento\s*([0-9.,]+\s*(?:km|k|m|min)?)/i);
        if (m) {
          warmupText = `Aquecimento: ${m[1]}`;
        }
      }

      todayWorkout = {
        name: ev.name || "Treino Agendado",
        description: ev.description ? ev.description.split("\n")[0] : "Consulte a planilha para detalhes.",
        warmup: warmupText,
        distance: ev.distance ? (ev.distance / 1000).toFixed(1) + " km" : "-",
        duration: ev.moving_time ? Math.round(ev.moving_time / 60) + " min" : "-"
      };
    }

    // --- CORRIDAS CONSOLIDADAS (HISTÓRICO + INTERVALS) ---
    const baseOctRuns = [
      { date: "2026-10-05", dist: 7.06, time: "42m17s", name: "Corrida noturna", avgHR: "-" },
      { date: "2026-10-08", dist: 7.51, time: "44m15s", name: "Corrida noturna", avgHR: "-" },
      { date: "2026-10-10", dist: 11.02, time: "1h01m", name: "Corrida matinal", avgHR: "-" },
      { date: "2026-10-13", dist: 1.30, time: "07m59s", name: "Corrida noturna", avgHR: "-" },
      { date: "2026-10-17", dist: 14.00, time: "2h14m", name: "Desafio 28 Praias 14K", avgHR: "-" },
      { date: "2026-10-19", dist: 6.34, time: "44m42s", name: "Corrida noturna", avgHR: "-" },
      { date: "2026-10-24", dist: 12.00, time: "1h11m", name: "Corrida matinal", avgHR: "-" },
      { date: "2026-10-26", dist: 7.32, time: "43m39s", name: "Corrida noturna", avgHR: "-" },
      { date: "2026-10-29", dist: 3.05, time: "19m09s", name: "Corrida noturna", avgHR: "-" },
      { date: "2026-10-31", dist: 15.01, time: "1h26m", name: "Longo", avgHR: "-" },
    ];

    const dynamicRuns = (Array.isArray(activitiesData) ? activitiesData : [])
      .filter((a) => a.type === "Run" || a.type === "VirtualRun" || a.type === "Corrida")
      .map((a) => {
        const paceSecs = a.distance > 0 && a.moving_time > 0 ? (a.moving_time / (a.distance / 1000)) : 0;
        const pMin = Math.floor(paceSecs / 60);
        const pSec = Math.floor(paceSecs % 60);
        const paceFormatted = paceSecs > 0 ? `${pMin}'${pSec.toString().padStart(2, "0")}"/km` : "-";
        const dateStr = (a.start_date_local || a.start_date).split("T")[0];

        return {
          id: a.id,
          date: dateStr,
          name: a.name || "Corrida",
          dist: a.distance ? a.distance / 1000 : 0,
          time: a.moving_time ? formatDuration(a.moving_time) : "-",
          pace: paceFormatted,
          avgHR: a.average_heartrate ? Math.round(a.average_heartrate) + " bpm" : "-"
        };
      });

    const allRecentRuns = [...baseOctRuns];
    dynamicRuns.forEach(dr => {
      const exists = allRecentRuns.some(ar => ar.date === dr.date && Math.abs(ar.dist - dr.dist) < 0.1);
      if (!exists) {
        allRecentRuns.push(dr);
      }
    });

    function formatDuration(sec) {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
      return `${m}m${s.toString().padStart(2, "0")}s`;
    }

    // --- FILTRAGEM: ATIVIDADES DA SEMANA PASSADA E DA SEMANA ATUAL ---
    const todayDateObj = new Date(`${todayStr}T12:00:00`);
    const dayOfWeek = todayDateObj.getDay();
    const diffToCurrentMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    
    const curMonday = new Date(todayDateObj.getTime() + diffToCurrentMonday * 24 * 60 * 60 * 1000);
    const curSunday = new Date(curMonday.getTime() + 6 * 24 * 60 * 60 * 1000);
    const lastMonday = new Date(curMonday.getTime() - 7 * 24 * 60 * 60 * 1000);
    const lastSunday = new Date(curMonday.getTime() - 1 * 24 * 60 * 60 * 1000);

    const toISODate = dt => dt.toISOString().split("T")[0];
    const curMonStr = toISODate(curMonday);
    const curSunStr = toISODate(curSunday);
    const lastMonStr = toISODate(lastMonday);
    const lastSunStr = toISODate(lastSunday);

    const toDisplayDate = iso => {
      const p = iso.split("-");
      return `${p[2]}/${p[1]}`;
    };
    const activitiesSubtitle = `Semana Passada (${toDisplayDate(lastMonStr)} a ${toDisplayDate(lastSunStr)}) & Semana Atual (${toDisplayDate(curMonStr)} a ${toDisplayDate(curSunStr)})`;

    const recentActivities = allRecentRuns
      .filter(r => r.date >= lastMonStr && r.date <= curSunStr)
      .sort((a,b) => b.date.localeCompare(a.date))
      .map(r => {
        const parts = r.date.split("-");
        const isCurrentWeek = r.date >= curMonStr;
        return {
          date: `${parts[2]}/${parts[1]}`,
          name: r.name,
          distance: r.dist.toFixed(2) + " km",
          duration: r.time,
          avgHR: r.avgHR || "-",
          weekGroup: isCurrentWeek ? "Semana Atual" : "Semana Passada"
        };
      });

    // --- CÁLCULO DE SEMANAS (SEGUNDA A DOMINGO COM REGRAS DE TRANSIÇÃO MENSAL) ---
    // 1. Domingo dia 01/11 pertence à última semana de Outubro (26/10 a 01/11).
    // 2. Se o primeiro dia da semana começar nos dias 30 ou 31 (Segunda-feira), pertence à primeira semana do próximo mês.
    function calculateSegDomWeeks(year, month, runList) {
      const pad = n => n.toString().padStart(2, "0");
      const toDisplay = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
      const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

      const d1 = new Date(year, month - 1, 1);
      let curDate = new Date(year, month - 1, d1.getDay() === 0 ? 2 : 1);

      const weeks = [];
      let weekNum = 1;

      while (curDate.getMonth() === month - 1) {
        // Se a semana inicia nos dias 30 ou 31 e for Segunda-feira (como 30/11), pertence à semana 1 do mês seguinte
        if (curDate.getDate() >= 30 && curDate.getDay() === 1) {
          break;
        }

        const wStart = new Date(curDate);
        const dow = wStart.getDay();
        const daysToSun = (7 - dow) % 7;
        const wEnd = new Date(wStart.getTime() + daysToSun * 24 * 60 * 60 * 1000);

        const startISO = toISO(wStart);
        const endISO = toISO(wEnd);

        const weekRuns = runList.filter(r => r.date >= startISO && r.date <= endISO);
        const totalKm = weekRuns.reduce((sum, r) => sum + r.dist, 0);

        weeks.push({
          label: `Semana ${weekNum} (${toDisplay(wStart)} a ${toDisplay(wEnd)})`,
          km: totalKm.toFixed(1) + " km",
          rawKm: Math.round(totalKm * 10) / 10,
          count: weekRuns.length
        });

        curDate = new Date(wEnd.getTime() + 24 * 60 * 60 * 1000);
        weekNum++;
      }

      const totalMonthKm = weeks.reduce((sum, w) => sum + w.rawKm, 0);
      const monthNames = ["", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

      return {
        month: `${monthNames[month]} / ${year}`,
        totalKm: totalMonthKm.toFixed(1) + " km",
        weeks
      };
    }

    const curYearNum = parseInt(yBr, 10);
    const curMonthNum = parseInt(mBr, 10);
    const prevMonthNum = curMonthNum === 1 ? 12 : curMonthNum - 1;
    const prevYearNum = curMonthNum === 1 ? curYearNum - 1 : curYearNum;

    const volumeStats = {
      previousMonth: calculateSegDomWeeks(prevYearNum, prevMonthNum, allRecentRuns),
      currentMonth: calculateSegDomWeeks(curYearNum, curMonthNum, allRecentRuns)
    };

    // --- HISTÓRICO DE CARGAS DE TREINO (ÚLTIMOS 6 MESES CONSOLIDADOS) ---
    const sixMonthsHistory = [
      { month: "Mai/26", km: "94.9 km", rawKm: 94.9, count: 19 },
      { month: "Jun/26", km: "98.8 km", rawKm: 98.8, count: 18 },
      { month: "Jul/26", km: "97.3 km", rawKm: 97.3, count: 22 },
      { month: "Ago/26", km: "87.6 km", rawKm: 87.6, count: 16 },
      { month: "Set/26", km: "124.1 km", rawKm: 124.1, count: 16 },
      { month: "Out/26", km: "84.6 km", rawKm: 84.6, count: 10 }
    ];

    // --- RECORDES PESSOAIS: RUA (GPS) vs ESTEIRA UNIFICADOS POR DISTÂNCIA ---
    const personalRecords = [
      {
        dist: "Melhor 1 km",
        primary: { type: "Rua (GPS)", time: "4'49\"", pace: "4'49\" /km", date: "23/08/2026" },
        secondary: { type: "Esteira", time: "4'32\"", pace: "4'32\" /km", date: "10/08/2026", hasData: true }
      },
      {
        dist: "Melhor 5 km",
        primary: { type: "Rua (GPS)", time: "25:49", pace: "5'10\" /km", date: "23/08/2026" },
        secondary: { type: "Esteira", time: "26:15", pace: "5'15\" /km", date: "08/10/2026", hasData: true }
      },
      {
        dist: "Melhor 10 km",
        primary: { type: "Rua (GPS)", time: "55:29", pace: "5'33\" /km", date: "19/09/2026" },
        secondary: { type: "Esteira", time: "56:53", pace: "5'41\" /km", date: "05/09/2026", hasData: true }
      },
      {
        dist: "Melhor 15 km",
        primary: { type: "Rua (GPS)", time: "1:26:12", pace: "5'45\" /km", date: "31/10/2026" },
        secondary: { type: "Esteira", time: "Sem registro", pace: "-", date: "-", hasData: false }
      },
      {
        dist: "Meia Maratona",
        isTarget: true,
        title: "Prova-Alvo",
        targetMeta: "Meta: Sub 2h00",
        targetPace: "Ritmo: (< 5'41\")",
        date: "04/04/2027 • SP"
      }
    ];

    // --- MOTOR DE PROTOCOLO DO DIA (TREINO + NUTRIÇÃO + GÉIS) ---
    const tomorrowObj = new Date(todayDateObj.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStr = toISODate(tomorrowObj);
    const tomorrowEvent = Array.isArray(eventsData)
      ? eventsData.find(e => e.start_date_local && e.start_date_local.startsWith(tomorrowStr))
      : null;
    const tomorrowDistKm = tomorrowEvent && tomorrowEvent.distance ? +(tomorrowEvent.distance / 1000).toFixed(1) : null;
    const todayDistKm = todayWorkout.distance && todayWorkout.distance !== "-"
      ? parseFloat(todayWorkout.distance.replace(" km", ""))
      : 0;

    const isQualityRun = /interval|tiro|fartlek|ritmo|teste|pirâmide|100m/i.test(todayWorkout.name || "");

    function makeDoubleDayProtocol(specificWorkoutName, specificDistKm, specificQuality) {
      const intraRunItem = specificQuality
        ? "1x Gel VO2 C30 Banana (31g carbo, 0mg cafeína) + 350ml água"
        : "1x Bananinha Tachão Sem Açúcar (~20g carbo) + 350ml água";
      return {
        key: "double",
        dayLabel: "Dia de Treino Duplo (Musculação + Esteira)",
        badge: specificQuality ? "Treino de Qualidade" : "Rodagem Aeróbica",
        targets: {
          kcal: "~2.400 kcal",
          carbs: "~285 g",
          protein: "~155 g",
          water: "3,5 L"
        },
        alerts: [
          `Musculação (17h30–19h15) ➡️ Esteira (${specificWorkoutName}): consuma o carboidrato intra-treino às 18h45–19h00 (15–30 min antes de correr) para já subir na esteira com energia disponível.`,
          "Use inclinação 0,5% a 1,0% na esteira para proteger tíbia (canelite) e joelho (condromalácia).",
          "PROIBIDO gel Z2+ com cafeína à noite (você já toma Évora PW às 17h00). Preserve seu sono."
        ],
        meals: [
          { time: "07h30", title: "Café da Manhã", detail: "Shot matinal • 200ml café+leite • 2 ovos • 65g cuscuz (seco) • muçarela + ricota • 60g mamão + 60g melão + fibras + 30g iogurte • 6g creatina + UC2", highlight: true },
          { time: "12h30", title: "Almoço", detail: "140g frango • 230g arroz • 50g feijão • Ômega 3 + Betaína/Pepsina + D3/K2", highlight: true },
          { time: "16h45", title: "Pré-Musculação", detail: "Base fixa: 200ml café+leite • 1 fatia muçarela • 80g banana prata c/ canela • Évora PW + 1 complemento abaixo", highlight: true },
          { time: "18h45–19h00", title: "Intra-Sessão (20–30 min antes da esteira)", detail: intraRunItem, highlight: true },
          { time: "20h45", title: "Jantar + Sobremesa", detail: "120g coxão mole • 150–180g carbo leve • salada + refri zero • 80g iogurte + 30g Whey + 1 pct Magic Toast (ou 1 col. sopa / 20g de geleia) • chá", highlight: true }
        ],
        gels: specificQuality
          ? [
              { moment: "18h55–19h00 (15–20 min antes da esteira)", item: "VO2 Energy Gel C30 Banana", note: "31g carbo • 0mg cafeína (absorção rápida)" }
            ]
          : [
              { moment: "18h45 (30 min antes da esteira)", item: "Bananinha Tachão Sem Açúcar", note: "~20g carbo natural • tempo ideal de digestão" }
            ],
        alternatives: [
          {
            title: "Carboidratos do Jantar (escolha 1 opção)",
            items: [
              "Arroz branco (150–170g cozido)",
              "Batata inglesa (220–250g)",
              "Mandioquinha / Baroa (180–200g)",
              "Batata-doce ou Mandioca (150–180g)",
              "Cuscuz (50g seco)",
              "Nhame ou Abóbora cabotiá (180g)"
            ]
          },
          {
            title: "Complemento Pré-Musculação (16h45 — mantém base fixa)",
            items: [
              "A: 1 col. sopa (20g) Doce de Leite Zero + 1/2 pct Magic Toast (3 unid.)",
              "B: 1/2 pct Magic Toast (3 unid.) com 1 col. sobremesa (13g) geleia caseira",
              "C: 1 col. sopa (20g) Doce de Leite Zero + 1 col. sobremesa (14g) mel",
              "D: 1 col. sopa (20g) Doce de Leite Zero + 1 Bananinha Tachão"
            ]
          },
          {
            title: "Sobremesa (20h45) & Intra-Treino (18h45–19h00)",
            items: [
              "Sobremesa: troca 1 pct Magic Toast por 1 col. sopa (20g) geleia ou 2 col. sopa (40g) Doce de Leite Zero",
              "Intra: 1x VO2 C30 Banana (qualidade) ou 1x Bananinha Tachão (rodagem)"
            ]
          }
        ]
      };
    }

    function makeWednesdayProtocol() {
      return {
        key: "wednesday",
        dayLabel: "Quarta-feira • Força de Pernas (Sem Corrida)",
        badge: "Proteção Patelar & Recuperação",
        targets: {
          kcal: "~2.150 kcal",
          carbs: "~220 g",
          protein: "~155 g",
          water: "3,0 L"
        },
        alerts: [
          "Treino de pernas mantendo 2–3 repetições na reserva (evite falha para não travar a corrida de quinta).",
          "Foco preventivo na condromalácia: priorize glúteo médio/máximo e isometria sem dor patelar.",
          "Sem esteira hoje: reduza levemente o arroz do almoço (200g) e o carbo do jantar (130g) mantendo a proteína alta."
        ],
        meals: [
          { time: "07h30", title: "Café da Manhã", detail: "Shot matinal • 200ml café+leite • 2 ovos • 65g cuscuz (seco) • muçarela + ricota • 60g mamão + 60g melão + fibras • 6g creatina + UC2", highlight: false },
          { time: "12h30", title: "Almoço", detail: "140g frango • 200g arroz • 50g feijão • Ômega 3 + Betaína/Pepsina + D3/K2", highlight: true },
          { time: "16h45", title: "Pré-Treino Pernas", detail: "Base fixa: 200ml café+leite • 1 fatia muçarela • 80g banana prata c/ canela • Évora PW + 1 complemento abaixo", highlight: false },
          { time: "20h30", title: "Jantar + Sobremesa", detail: "120g coxão mole • 130g carbo leve • salada + refri zero • 80g iogurte + 30g Whey + 1 pct Magic Toast • chá", highlight: true }
        ],
        gels: [],
        alternatives: [
          {
            title: "Carboidratos do Jantar (130g–160g, escolha 1)",
            items: [
              "Arroz branco (130g cozido)",
              "Batata inglesa (180–200g)",
              "Mandioquinha ou Nhame (150g)",
              "Cuscuz (40g seco)"
            ]
          },
          {
            title: "Complemento Pré-Treino Pernas (16h45 — mantém base fixa)",
            items: [
              "A: 1 col. sopa (20g) Doce de Leite Zero + 1/2 pct Magic Toast (3 unid.)",
              "B: 1/2 pct Magic Toast (3 unid.) com 1 col. sobremesa (13g) geleia caseira",
              "C: 1 Bananinha Tachão Sem Açúcar"
            ]
          }
        ]
      };
    }

    function makeFridayProtocol() {
      const satInfo = tomorrowEvent
        ? `Amanhã: ${tomorrowEvent.name}${tomorrowDistKm ? ` (${tomorrowDistKm} km)` : ""}.`
        : "Amanhã é dia de Longão na rua (08h30–09h00).";
      return {
        key: "friday",
        dayLabel: "Sexta-feira • Descanso de Corrida + Pré-Longão",
        badge: "Carb-Loading Leve",
        targets: {
          kcal: "~2.350 kcal",
          carbs: "~270 g+",
          protein: "~150 g",
          water: "3,0 L"
        },
        alerts: [
          `${satInfo} O objetivo hoje é encher o tanque de glicogênio sem desconforto gástrico.`,
          "Jantar livre estratégico: 4 esfihas abertas (carne/frango) ou macarrão com atum e molho.",
          "Durma cedo (meta 7h30–8h de sono) e separe os géis e a água para amanhã de manhã."
        ],
        meals: [
          { time: "07h30", title: "Café da Manhã", detail: "Shot matinal • 200ml café+leite • 2 ovos • 65g cuscuz (seco) • muçarela + ricota • frutas + fibras • 6g creatina + UC2", highlight: false },
          { time: "12h30", title: "Almoço", detail: "140g frango • 200g arroz • 50g feijão • Ômega 3 + Betaína/Pepsina + D3/K2", highlight: false },
          { time: "16h45", title: "Lanche da Tarde", detail: "Base fixa: 200ml café+leite • 1 fatia muçarela • 80g banana prata c/ canela + 1 complemento abaixo", highlight: false },
          { time: "20h30", title: "Jantar Pré-Longão", detail: "4 esfihas abertas (carne/frango) OU macarrão com atum e molho • refri zero • chá antes de dormir", highlight: true }
        ],
        gels: [],
        alternatives: [
          {
            title: "Complemento Lanche da Tarde (16h45 — mantém base fixa)",
            items: [
              "A: 1 col. sopa (20g) Doce de Leite Zero + 1/2 pct Magic Toast (3 unid.)",
              "B: 1/2 pct Magic Toast (3 unid.) com 1 col. sobremesa (13g) geleia caseira",
              "C: 1 col. sopa (20g) Doce de Leite Zero + 1 col. sobremesa (14g) mel",
              "D: 1 col. sopa (20g) Doce de Leite Zero + 1 Bananinha Tachão"
            ]
          },
          {
            title: "Opções de Jantar Carb-Loading (Sexta)",
            items: [
              "4 esfihas abertas (carne e frango)",
              "Macarrão com atum e molho de tomate",
              "Ou prato reforçado: 220g arroz + 140g frango"
            ]
          }
        ]
      };
    }

    function makeSaturdayProtocol(distKm) {
      const d = distKm && distKm > 0 ? distKm : 16;
      const isLongPlus = d >= 15;
      const isHalfOrMore = d >= 18;
      const gelSteps = isHalfOrMore
        ? [
            { moment: "35 min de corrida", item: "1x VO2 C30 Banana", note: "31g carbo • 0mg cafeína" },
            { moment: "1h05–1h10 de corrida", item: "1x Z2+ Energy Lime", note: "25g carbo • 200mg sódio • 100mg cafeína" },
            { moment: "1h40 (últimos km)", item: "1x Z2+ Iced Coffee", note: "25g carbo • 200mg sódio • 150mg cafeína" }
          ]
        : isLongPlus
        ? [
            { moment: "35–40 min de corrida", item: "1x VO2 C30 Banana", note: "31g carbo • 0mg cafeína" },
            { moment: "1h05–1h10 de corrida", item: "1x Z2+ Energy Lime", note: "25g carbo • 200mg sódio • 100mg cafeína" }
          ]
        : [
            { moment: "40 min (se precisar)", item: "1x VO2 C30 Banana ou Bananinha Tachão", note: "20–31g carbo • opcional abaixo de 14 km" }
          ];

      return {
        key: "saturday",
        dayLabel: `Sábado • Longão na Rua (${d.toFixed(1)} km)`,
        badge: isLongPlus ? "Longão + Protocolo de Géis" : "Rodagem na Rua",
        targets: {
          kcal: "Livre Controlado",
          carbs: "~75–80g pré",
          protein: "~150 g",
          water: "500–650 ml/h"
        },
        alerts: [
          "07h00 em ponto: tome 5g a 10g de pó de beterraba junto com o café (pico de vasodilatação às 08h30–09h00).",
          isLongPlus
            ? "Treino ≥ 15 km: mantenha apenas 1 pct Magic Toast e reforce com +1 col. sopa (20g) de geleia ou +1 col. sobremesa (14g) de mel."
            : "Tome 2 a 3 goles de água após cada gel para acelerar a absorção.",
          "Pós-treino e resto do fim de semana livres com bom senso: mantenha proteína e não exagere nas gorduras."
        ],
        meals: [
          { time: "07h00", title: "Café Pré-Longão (90–120 min antes)", detail: `200ml café • ${isLongPlus ? "100g banana prata + 1 col. sopa (21g) de mel" : "80g banana prata + 1 col. sobremesa (14g) de mel"} • 1 Paçoquita • 1 pct Magic Toast com ${isLongPlus ? "1 col. sopa cheia (20g) + 1 col. chá (7g)" : "1 col. sopa (20g)"} de geleia caseira • 5–10g pó de beterraba • 6g creatina + UC2`, highlight: true },
          { time: "08h30–09h00", title: "Durante o Longão (Intra)", detail: isLongPlus ? "Géis nos horários abaixo + 500ml de água ao longo do percurso" : "350 a 500ml de água em pequenos goles", highlight: true },
          { time: "Pós-Treino", title: "Almoço & Fim de Semana", detail: "Livre controlado: priorize boa fonte de proteína + carboidrato para recuperar o longão", highlight: false }
        ],
        gels: gelSteps,
        alternatives: [
          {
            title: "Reforço Pré-Longão (07h00, sem precisar de 2 pcts Magic Toast)",
            items: [
              "1 col. sopa (20g) geleia caseira = substitui 1 pct inteiro de Magic Toast",
              "1 col. sopa (21g) mel = ~17g carbo (ou 1 col. sobremesa / 14g = ~11g carbo)",
              "2 col. sopa (40g) Doce de Leite Zero Junco = alternativa ao mel/geleia",
              "Ou +1 Bananinha Tachão Sem Açúcar (~20g carbo)"
            ]
          },
          {
            title: "Ordem dos Géis no Longão",
            items: [
              "1º Gel (~35–40 min): VO2 C30 Banana (0mg cafeína)",
              "2º Gel (~1h05–1h10): Z2+ Energy Lime (100mg caf + 200mg Na)",
              "3º Gel (~1h40, se ≥18 km): Z2+ Iced Coffee (150mg caf + 200mg Na)"
            ]
          }
        ]
      };
    }

    function makeSundayProtocol() {
      return {
        key: "sunday",
        dayLabel: "Domingo • Descanso Total & Recuperação",
        badge: "Regeneração",
        targets: {
          kcal: "Livre Controlado",
          carbs: "Moderado",
          protein: "~150 g",
          water: "3,0 L"
        },
        alerts: [
          "Dia de descanso completo para absorver o volume do longão de sábado.",
          "Refeições livres com bom senso: mantenha boa ingestão de proteína e 3L de água.",
          "À noite, evite exageros pesados para acordar leve na segunda-feira."
        ],
        meals: [
          { time: "Manhã", title: "Café da Manhã", detail: "Livre controlado • manter 6g creatina + UC2 + shot matinal se desejar", highlight: false },
          { time: "Almoço / Jantar", title: "Refeições do Dia", detail: "Livres com bom senso (bater proteína e evitar excessos calóricos)", highlight: false }
        ],
        gels: [],
        alternatives: []
      };
    }

    let todayProtocol;
    if (dayOfWeek === 6) {
      todayProtocol = makeSaturdayProtocol(todayDistKm);
    } else if (dayOfWeek === 5) {
      todayProtocol = makeFridayProtocol();
    } else if (dayOfWeek === 3) {
      todayProtocol = makeWednesdayProtocol();
    } else if (dayOfWeek === 0) {
      todayProtocol = makeSundayProtocol();
    } else {
      todayProtocol = makeDoubleDayProtocol(todayWorkout.name, todayDistKm, isQualityRun);
    }

    const dailyProtocol = {
      today: todayProtocol,
      presets: {
        today: todayProtocol,
        double: makeDoubleDayProtocol(
          (dayOfWeek === 1 || dayOfWeek === 2 || dayOfWeek === 4) ? todayWorkout.name : "Treino de Esteira",
          todayDistKm || 6,
          dayOfWeek === 2 || dayOfWeek === 4 || isQualityRun
        ),
        wednesday: makeWednesdayProtocol(),
        friday: makeFridayProtocol(),
        saturday: makeSaturdayProtocol(dayOfWeek === 6 ? todayDistKm : (tomorrowDistKm || 16))
      }
    };

    // AI Coach recommendation dynamic rule-engine
    let coachAdvice = "";
    if (tsb >= -10 && tsb <= 5) {
      coachAdvice = `Equilíbrio fisiológico estável hoje (TSB: ${tsb > 0 ? "+" : ""}${tsb}, FC Repouso: ${restingHR} bpm). ${dayOfWeek === 5 ? "Sem corrida hoje: foque no carb-loading leve do jantar para o longão de amanhã." : `Prontidão ótima para cumprir **${todayWorkout.name}**.`} ${todayWorkout.warmup ? `Inclua o **${todayWorkout.warmup}** antes da parte principal.` : ""}`;
    } else if (tsb < -15) {
      coachAdvice = `Atenção à fadiga aguda acumulada (TSB: ${tsb}). Segure o pace na zona confortável, garanta o intra-treino e capricho na hidratação (3,5L).`;
    } else {
      coachAdvice = `Sistema cardiovascular descansado (FC Repouso: ${restingHR} bpm). Excelente janela para manter consistência no treino e nos ajustes de carboidrato.`;
    }

    // Cache control for performance (5 min browser cache, 10 min edge cache)
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.setHeader("Content-Type", "application/json");

    return res.status(200).json({
      success: true,
      updatedAt: brTimeStr,
      date: now.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "numeric", month: "long" }),
      athlete: {
        name: "Victor Rafael",
        id: ATHLETE_ID
      },
      readiness: {
        restingHR,
        restingHRSub,
        restingHROk,
        ctl,
        atl,
        tsb,
        formStatus,
        formBadge,
        formNote
      },
      todayWorkout,
      dailyProtocol,
      volumeStats,
      sixMonthsHistory,
      coachAdvice,
      personalRecords,
      activitiesSubtitle,
      recentActivities
    });

  } catch (error) {
    console.error("Intervals API Error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Erro ao consultar a API do Intervals.icu"
    });
  }
}
