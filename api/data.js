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
    const latestWellness = Array.isArray(wellnessData) && wellnessData.length > 0 
      ? wellnessData[wellnessData.length - 1] 
      : {};

    const restingHR = latestWellness.restingHR || 50;
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

    const volumeStats = {
      previousMonth: calculateSegDomWeeks(2026, 10, allRecentRuns),
      currentMonth: calculateSegDomWeeks(2026, 11, allRecentRuns)
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
        date: "Abril / 2027"
      }
    ];

    // AI Coach recommendation dynamic rule-engine
    let coachAdvice = "";
    if (tsb >= -10 && tsb <= 5) {
      coachAdvice = `Seu corpo está em excelente equilíbrio fisiológico hoje (TSB: ${tsb > 0 ? "+" : ""}${tsb}, FC Repouso: ${restingHR} bpm). O nível de prontidão está ótimo para absorver a sessão de hoje: **${todayWorkout.name}**. ${todayWorkout.warmup ? `Comece com o **${todayWorkout.warmup}** antes das acelerações.` : "Mantenha a cadência estável."}`;
    } else if (tsb < -15) {
      coachAdvice = `Atenção à sobrecarga aguda acumulada (TSB: ${tsb}). Se sentir pernas pesadas, priorize manter os ritmos na zona aeróbica confortável e hidrate-se bem após o treino.`;
    } else {
      coachAdvice = `Prontidão recuperada e sistema cardiovascular descansado (FC Repouso: ${restingHR} bpm). Ótimo momento para colocar o plano em prática com boa consistência.`;
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
        ctl,
        atl,
        tsb,
        formStatus,
        formBadge,
        formNote
      },
      todayWorkout,
      volumeStats,
      sixMonthsHistory,
      coachAdvice,
      personalRecords,
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
