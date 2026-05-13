import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, MapPin, Building2, Globe, Download, Loader2, Play, Square, Terminal, Table as TableIcon, Settings, LayoutDashboard, ChevronDown, Check, Leaf } from 'lucide-react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { motion, AnimatePresence } from 'framer-motion';
import { plzData, PlzEntry } from './data/plz_data';

type SearchMode = 'radius' | 'landkreis';

interface SelectedArea {
  label: string;
  isBundesland: boolean;
  plzEntries: PlzEntry[];
}

interface LogEntry {
  id: string;
  type: 'info' | 'error' | 'result' | 'done';
  message?: string;
  data?: any;
  timestamp: Date;
}

export default function App() {
  const [industries, setIndustries] = useState<string[]>([]);
  const [industryInput, setIndustryInput] = useState('');
  const [mode, setMode] = useState<SearchMode>('radius');
  const [city, setCity] = useState('');
  const [radius, setRadius] = useState(10);
  const [ecoMode, setEcoMode] = useState(false);
  const [maxLeads, setMaxLeads] = useState<number>(0);

  const [selectedArea, setSelectedArea] = useState<SelectedArea>({
    label: `${plzData[0].kreis} (${plzData[0].plz})`,
    isBundesland: false,
    plzEntries: [plzData[0]]
  });
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  const filteredPlz = plzData.filter(e =>
    e.kreis.toLowerCase().includes(searchQuery.toLowerCase()) ||
    e.bundesland.toLowerCase().includes(searchQuery.toLowerCase()) ||
    e.plz.includes(searchQuery)
  );

  const groupedPlz = filteredPlz.reduce((acc, entry) => {
    if (!acc[entry.bundesland]) acc[entry.bundesland] = [];
    acc[entry.bundesland].push(entry);
    return acc;
  }, {} as Record<string, PlzEntry[]>);

  const [isSearching, setIsSearching] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [results, setResults] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'terminal' | 'results'>('terminal');
  const [requireFullData, setRequireFullData] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historyData, setHistoryData] = useState<any[]>([]);
  const [historyStep, setHistoryStep] = useState<'date' | 'search' | 'download'>('date');
  const [selectedHistoryDate, setSelectedHistoryDate] = useState<string | null>(null);
  const [selectedHistorySearch, setSelectedHistorySearch] = useState<any | null>(null);
  const historyDropdownRef = useRef<HTMLDivElement>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const currentJobIdRef = useRef<string | null>(null);
  const resultCountRef = useRef(0);
  const logCountRef = useRef(0);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const filteredResults = results.filter(r => {
    if (!requireFullData) return true;
    return r.anrede && r.vorname && r.nachname && r.phone && r.email;
  });

  // Eco checkbox visible: always in radius mode, in landkreis mode only when whole Bundesland is selected
  const showEco = mode === 'radius' || (mode === 'landkreis' && selectedArea.isBundesland);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
      if (historyDropdownRef.current && !historyDropdownRef.current.contains(event.target as Node)) {
        setIsHistoryOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const connectToJob = useCallback((jobId: string) => {
    currentJobIdRef.current = jobId;

    const connectSSE = () => {
      const sse = new EventSource(
        `/api/job-stream?jobId=${jobId}&lastResultCount=${resultCountRef.current}&lastLogCount=${logCountRef.current}`
      );
      eventSourceRef.current = sse;

      sse.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'done') {
          sse.close();
          eventSourceRef.current = null;
          currentJobIdRef.current = null;
          setIsSearching(false);
          localStorage.removeItem('activeJobId');
          setLogs(prev => [...prev, {
            id: Math.random().toString(),
            type: 'done',
            message: 'Aufgabe abgeschlossen.',
            timestamp: new Date()
          }]);
          return;
        }

        if (data.type === 'result') {
          resultCountRef.current++;
          setResults(prev => {
            if (prev.some(r => r.id === data.data.id && r.companyName === data.data.companyName)) return prev;
            return [...prev, data.data];
          });
        } else {
          logCountRef.current++;
        }

        setLogs(prev => [...prev, {
          id: Math.random().toString(),
          type: data.type,
          message: data.message,
          data: data.data,
          timestamp: new Date()
        }]);
      };

      sse.onerror = () => {
        sse.close();
        if (currentJobIdRef.current === jobId) {
          setLogs(prev => [...prev, {
            id: Math.random().toString(),
            type: 'error',
            message: 'Verbindung verloren. Versuche Neuverbindung...',
            timestamp: new Date()
          }]);
          setTimeout(() => {
            if (currentJobIdRef.current === jobId) {
              connectSSE();
            }
          }, 3000);
        }
      };
    };

    connectSSE();
  }, []);

  // On mount: check if there's an active job from before a page refresh
  useEffect(() => {
    const savedJobId = localStorage.getItem('activeJobId');
    if (!savedJobId) return;

    fetch(`/api/job-status?jobId=${savedJobId}`)
      .then(r => r.json())
      .then(data => {
        if (data.exists && !data.isDone) {
          resultCountRef.current = 0;
          logCountRef.current = 0;
          setIsSearching(true);
          setActiveTab('terminal');
          setLogs([{
            id: 'reconnect',
            type: 'info',
            message: 'Verbindung zum laufenden Scraping wiederhergestellt...',
            timestamp: new Date()
          }]);
          connectToJob(savedJobId);
        } else {
          localStorage.removeItem('activeJobId');
        }
      })
      .catch(() => localStorage.removeItem('activeJobId'));
  }, [connectToJob]);

  const handleStart = async () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    currentJobIdRef.current = null;

    const finalIndustries = [...industries];
    if (industryInput.trim() && !finalIndustries.includes(industryInput.trim())) {
      finalIndustries.push(industryInput.trim());
      setIndustries(finalIndustries);
      setIndustryInput('');
    }

    if (finalIndustries.length === 0) {
      alert('Bitte geben Sie mindestens eine Branche ein.');
      return;
    }

    setIsSearching(true);
    setLogs([]);
    setResults([]);
    setActiveTab('terminal');
    resultCountRef.current = 0;
    logCountRef.current = 0;

    try {
      const res = await fetch('/api/start-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          industries: finalIndustries,
          mode,
          city: mode === 'radius' ? city : undefined,
          radius: mode === 'radius' ? radius : undefined,
          plzEntries: mode === 'landkreis' ? selectedArea.plzEntries : undefined,
          ecoMode: showEco ? ecoMode : false,
          maxLeads: maxLeads > 0 ? maxLeads : 0
        })
      });

      if (!res.ok) throw new Error('Failed to start job');

      const { jobId } = await res.json();
      localStorage.setItem('activeJobId', jobId);
      connectToJob(jobId);

    } catch (error: any) {
      console.error(error);
      setIsSearching(false);
      setLogs(prev => [...prev, {
        id: Math.random().toString(),
        type: 'error',
        message: error.message,
        timestamp: new Date()
      }]);
    }
  };

  const handleStop = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    currentJobIdRef.current = null;
    localStorage.removeItem('activeJobId');
    setIsSearching(false);
    setLogs(prev => [...prev, {
      id: Math.random().toString(),
      type: 'error',
      message: 'Aufgabe vom Benutzer gestoppt.',
      timestamp: new Date()
    }]);
  };

  const exportCSV = () => {
    if (filteredResults.length === 0) return;
    const csv = Papa.unparse(filteredResults);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `leads_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  const exportXLSX = () => {
    if (filteredResults.length === 0) return;
    const worksheet = XLSX.utils.json_to_sheet(filteredResults);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Leads");
    XLSX.writeFile(workbook, `leads_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const openHistory = async () => {
    setIsHistoryOpen(!isHistoryOpen);
    if (!isHistoryOpen) {
      setHistoryStep('date');
      setSelectedHistoryDate(null);
      setSelectedHistorySearch(null);
      try {
        const res = await fetch('/api/history');
        if (res.ok) {
          setHistoryData(await res.json());
        }
      } catch (e) {
        console.error('Failed to fetch history index', e);
      }
    }
  };

  const downloadHistory = async (format: 'csv' | 'xlsx', full: boolean) => {
    if (!selectedHistorySearch) return;
    try {
      const res = await fetch(`/api/history/${selectedHistorySearch.id}`);
      if (!res.ok) {
        alert('Keine Historie gefunden.');
        return;
      }
      const data = await res.json();

      let toExport = data;
      if (full) {
        toExport = data.filter((r: any) => r.anrede && r.vorname && r.nachname && r.phone && r.email);
      }

      if (toExport.length === 0) {
        alert('Keine Ergebnisse zum Exportieren in der Historie.');
        return;
      }

      if (format === 'csv') {
        const csv = Papa.unparse(toExport);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `history_${selectedHistorySearch.date}_${formatSearchLabel(selectedHistorySearch.config).replace(/[^a-z0-9]/gi, '_')}.csv`;
        link.click();
      } else {
        const worksheet = XLSX.utils.json_to_sheet(toExport);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Leads");
        XLSX.writeFile(workbook, `history_${selectedHistorySearch.date}_${formatSearchLabel(selectedHistorySearch.config).replace(/[^a-z0-9]/gi, '_')}.xlsx`);
      }
    } catch (e) {
      alert('Fehler beim Herunterladen der Historie.');
    }
    setIsHistoryOpen(false);
  };

  const formatSearchLabel = (config: any) => {
    const ind = config.industries.join(', ');
    if (config.mode === 'radius') {
      return `${ind} in ${config.city} (${config.radius}km)`;
    } else {
      return `${ind} in ${config.plzLabel || config.landkreis || 'Landkreis'}`;
    }
  };

  const uniqueDates = Array.from(new Set(historyData.map(h => h.date)));
  const searchesForDate = historyData.filter(h => h.date === selectedHistoryDate);

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-gray-300 font-sans overflow-hidden selection:bg-orange-500/30">

      <main className="flex-1 flex flex-col h-full overflow-hidden relative">
        {/* Topbar */}
        <header className="h-16 border-b border-white/10 flex items-center justify-between px-6 bg-[#0a0a0a]/80 backdrop-blur-md z-10">
          <div className="flex items-center gap-3">
            <img src="https://prospert.ai/wp-content/uploads/2024/11/Design-ohne-Titel-2025-11-04T111018.542.webp" alt="Prospert Logo" className="h-8 w-auto" referrerPolicy="no-referrer" />
            <h1 className="text-lg font-bold text-white tracking-wide">Prospert Scraper</h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="relative" ref={historyDropdownRef}>
              <button
                onClick={openHistory}
                className="text-xs flex items-center gap-2 bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded text-gray-300 transition-colors"
              >
                <Download className="w-3 h-3" /> Historie
              </button>
              <AnimatePresence>
                {isHistoryOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="absolute right-0 mt-2 w-72 bg-[#111] border border-white/10 rounded-lg shadow-2xl z-50 overflow-hidden max-h-96 overflow-y-auto"
                  >
                    <div className="p-2 flex flex-col gap-1">
                      {historyStep === 'date' && (
                        <>
                          <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase">Datum auswählen</div>
                          {uniqueDates.length === 0 ? (
                            <div className="px-3 py-2 text-sm text-gray-400">Keine Historie vorhanden.</div>
                          ) : (
                            uniqueDates.map(date => (
                              <button
                                key={date}
                                onClick={() => { setSelectedHistoryDate(date); setHistoryStep('search'); }}
                                className="text-left px-3 py-2 text-sm text-gray-300 hover:bg-white/5 rounded transition-colors flex justify-between items-center"
                              >
                                <span>{date}</span>
                                <span className="text-xs text-gray-500">{historyData.filter(h => h.date === date).length} Suchen</span>
                              </button>
                            ))
                          )}
                        </>
                      )}

                      {historyStep === 'search' && (
                        <>
                          <div className="flex items-center gap-2 px-3 py-2">
                            <button onClick={() => setHistoryStep('date')} className="text-gray-400 hover:text-white text-xs">← Zurück</button>
                            <div className="text-xs font-semibold text-gray-500 uppercase flex-1 text-right">Suche auswählen</div>
                          </div>
                          <div className="h-px bg-white/10 my-1"></div>
                          {searchesForDate.map(search => (
                            <button
                              key={search.id}
                              onClick={() => { setSelectedHistorySearch(search); setHistoryStep('download'); }}
                              className="text-left px-3 py-2 text-sm text-gray-300 hover:bg-white/5 rounded transition-colors flex flex-col gap-1"
                            >
                              <span className="font-medium truncate w-full">{formatSearchLabel(search.config)}</span>
                              <span className="text-xs text-gray-500">{new Date(search.timestamp).toLocaleTimeString('de-DE')} • {search.resultCount} Ergebnisse</span>
                            </button>
                          ))}
                        </>
                      )}

                      {historyStep === 'download' && selectedHistorySearch && (
                        <>
                          <div className="flex items-center gap-2 px-3 py-2">
                            <button onClick={() => setHistoryStep('search')} className="text-gray-400 hover:text-white text-xs">← Zurück</button>
                            <div className="text-xs font-semibold text-gray-500 uppercase flex-1 text-right">Download</div>
                          </div>
                          <div className="h-px bg-white/10 my-1"></div>
                          <div className="px-3 py-2 text-xs text-orange-400 truncate w-full">{formatSearchLabel(selectedHistorySearch.config)}</div>

                          <div className="px-3 py-2 mt-2 text-xs font-semibold text-gray-500 uppercase">Vollständige Daten (mit E-Mail)</div>
                          <button onClick={() => downloadHistory('csv', true)} className="text-left px-3 py-2 text-sm text-gray-300 hover:bg-white/5 rounded transition-colors">Als CSV herunterladen</button>
                          <button onClick={() => downloadHistory('xlsx', true)} className="text-left px-3 py-2 text-sm text-gray-300 hover:bg-white/5 rounded transition-colors">Als XLSX herunterladen</button>

                          <div className="h-px bg-white/10 my-1"></div>
                          <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase">Alle Daten</div>
                          <button onClick={() => downloadHistory('csv', false)} className="text-left px-3 py-2 text-sm text-gray-300 hover:bg-white/5 rounded transition-colors">Als CSV herunterladen</button>
                          <button onClick={() => downloadHistory('xlsx', false)} className="text-left px-3 py-2 text-sm text-gray-300 hover:bg-white/5 rounded transition-colors">Als XLSX herunterladen</button>
                        </>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <span className="text-xs font-mono text-gray-500">v2.2</span>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">

          {/* Configuration Panel */}
          <section className="bg-[#111] border border-white/10 rounded-xl p-6 shadow-2xl">
            <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-6 flex items-center gap-2">
              <Settings className="w-4 h-4" /> Aufgabenkonfiguration
            </h3>

            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-6">
              <div className="space-y-2">
                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Zielbranche</label>
                <div className="relative">
                  <div className="w-full bg-black/50 border border-white/10 rounded-lg pl-10 pr-4 py-1.5 min-h-[44px] flex flex-wrap items-center gap-2 focus-within:ring-1 focus-within:ring-orange-500 focus-within:border-orange-500 transition-all">
                    <Building2 className="absolute left-3 top-3 w-4 h-4 text-gray-500" />
                    {industries.map((ind, idx) => (
                      <span key={idx} className="bg-orange-500/20 text-orange-400 text-xs px-2 py-1 rounded-md flex items-center gap-1">
                        {ind}
                        <button onClick={() => setIndustries(industries.filter((_, i) => i !== idx))} className="hover:text-orange-300">
                          &times;
                        </button>
                      </span>
                    ))}
                    <input
                      type="text"
                      value={industryInput}
                      onChange={e => {
                        if (e.target.value.includes(',')) {
                          const parts = e.target.value.split(',');
                          const newIndustries = [...industries];
                          let lastPart = '';

                          parts.forEach((part, index) => {
                            const trimmed = part.trim();
                            if (index === parts.length - 1) {
                              lastPart = part;
                            } else if (trimmed && !newIndustries.includes(trimmed)) {
                              newIndustries.push(trimmed);
                            }
                          });

                          setIndustries(newIndustries);
                          setIndustryInput(lastPart.startsWith(' ') ? lastPart.trimStart() : lastPart);
                        } else {
                          setIndustryInput(e.target.value);
                        }
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const val = industryInput.trim();
                          if (val && !industries.includes(val)) {
                            setIndustries([...industries, val]);
                          }
                          setIndustryInput('');
                        } else if (e.key === 'Backspace' && !industryInput && industries.length > 0) {
                          setIndustries(industries.slice(0, -1));
                        }
                      }}
                      onBlur={() => {
                        const val = industryInput.trim();
                        if (val && !industries.includes(val)) {
                          setIndustries([...industries, val]);
                        }
                        setIndustryInput('');
                      }}
                      placeholder={industries.length === 0 ? "z.B. Zahnarzt, Autohaus" : ""}
                      className="flex-1 bg-transparent text-sm text-white outline-none min-w-[120px] py-1"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Suchmodus</label>
                <div className="flex bg-black/50 border border-white/10 rounded-lg p-1">
                  <button
                    onClick={() => setMode('radius')}
                    className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-all ${mode === 'radius' ? 'bg-orange-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}
                  >
                    Radius-Raster
                  </button>
                  <button
                    onClick={() => setMode('landkreis')}
                    className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-all ${mode === 'landkreis' ? 'bg-orange-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}
                  >
                    Landkreis
                  </button>
                </div>
              </div>

              {mode === 'radius' ? (
                <>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Zentrum / Ort</label>
                    <div className="relative">
                      <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                      <input
                        type="text"
                        value={city}
                        onChange={e => setCity(e.target.value)}
                        placeholder="z.B. Berlin"
                        className="w-full bg-black/50 border border-white/10 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white focus:ring-1 focus:ring-orange-500 focus:border-orange-500 outline-none transition-all"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-gray-400 uppercase tracking-wider flex justify-between">
                      <span>Radius</span>
                      <span className="text-orange-400">{radius} km</span>
                    </label>
                    <input
                      type="range"
                      min="1" max="50"
                      value={radius}
                      onChange={e => setRadius(Number(e.target.value))}
                      className="w-full accent-orange-500 mt-2"
                    />
                  </div>
                </>
              ) : (
                <div className="space-y-2 xl:col-span-2" ref={dropdownRef}>
                  <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Bundesland oder Landkreis auswählen</label>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                      className="w-full bg-black/50 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white focus:ring-1 focus:ring-orange-500 focus:border-orange-500 outline-none transition-all flex justify-between items-center"
                    >
                      <span className="truncate">
                        {selectedArea.isBundesland ? (
                          <span className="font-bold text-orange-400">{selectedArea.label}</span>
                        ) : (
                          <>
                            {selectedArea.plzEntries[0]?.kreis}
                            <span className="text-gray-500 text-xs font-normal ml-1">
                              ({selectedArea.plzEntries[0]?.bundesland} · PLZ {selectedArea.plzEntries[0]?.plz})
                            </span>
                          </>
                        )}
                      </span>
                      <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    <AnimatePresence>
                      {isDropdownOpen && (
                        <motion.div
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          className="absolute z-50 w-full mt-2 bg-[#111] border border-white/10 rounded-lg shadow-2xl overflow-hidden flex flex-col"
                          style={{ maxHeight: '300px' }}
                        >
                          <div className="p-2 border-b border-white/10 relative shrink-0">
                            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                            <input
                              type="text"
                              placeholder="Landkreis oder PLZ suchen..."
                              value={searchQuery}
                              onChange={(e) => setSearchQuery(e.target.value)}
                              className="w-full bg-black/50 border border-white/10 rounded-md pl-9 pr-4 py-2 text-sm text-white focus:outline-none focus:border-orange-500"
                            />
                          </div>
                          <div className="overflow-y-auto p-1 flex-1">
                            {Object.keys(groupedPlz).length === 0 ? (
                              <div className="p-3 text-sm text-gray-500 text-center">Keine Ergebnisse gefunden.</div>
                            ) : (
                              Object.entries(groupedPlz).sort(([a], [b]) => a.localeCompare(b)).map(([bundesland, entries]) => (
                                <div key={bundesland} className="mb-2">
                                  <button
                                    onClick={() => {
                                      const allEntries = plzData.filter(e => e.bundesland === bundesland);
                                      setSelectedArea({
                                        label: `${bundesland} (Gesamtes Bundesland)`,
                                        isBundesland: true,
                                        plzEntries: allEntries
                                      });
                                      setIsDropdownOpen(false);
                                      setSearchQuery('');
                                    }}
                                    className="w-full text-left sticky top-0 bg-[#111] px-3 py-2 text-xs font-bold text-orange-500 uppercase tracking-wider border-b border-white/5 z-10 hover:bg-white/5 transition-colors flex justify-between items-center"
                                  >
                                    <span>{bundesland} (Gesamtes Bundesland)</span>
                                    {selectedArea.isBundesland && selectedArea.label === `${bundesland} (Gesamtes Bundesland)` && <Check className="w-4 h-4 text-orange-500" />}
                                  </button>
                                  {entries.map((entry) => (
                                    <button
                                      key={entry.plz}
                                      onClick={() => {
                                        setSelectedArea({
                                          label: `${entry.kreis} (${entry.plz})`,
                                          isBundesland: false,
                                          plzEntries: [entry]
                                        });
                                        setIsDropdownOpen(false);
                                        setSearchQuery('');
                                      }}
                                      className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex flex-col gap-1 ${!selectedArea.isBundesland && selectedArea.plzEntries[0]?.plz === entry.plz ? 'bg-orange-500/20 text-orange-400' : 'text-gray-300 hover:bg-white/5'}`}
                                    >
                                      <div className="flex justify-between items-center">
                                        <span className="font-medium">{entry.kreis}</span>
                                        <span className="text-gray-500 text-xs ml-2 shrink-0">{entry.plz}</span>
                                        {!selectedArea.isBundesland && selectedArea.plzEntries[0]?.plz === entry.plz && <Check className="w-4 h-4 text-orange-500 ml-1" />}
                                      </div>
                                    </button>
                                  ))}
                                </div>
                              ))
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              )}
            </div>

            {/* Eco Mode + Max Leads row */}
            <div className="mt-5 pt-5 border-t border-white/5 flex flex-wrap items-center gap-6">
              <AnimatePresence>
                {showEco && (
                  <motion.div
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    className="flex items-center gap-2.5"
                  >
                    <div
                      onClick={() => setEcoMode(!ecoMode)}
                      className={`w-9 h-5 rounded-full cursor-pointer transition-colors relative ${ecoMode ? 'bg-green-600' : 'bg-white/10'}`}
                    >
                      <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${ecoMode ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Leaf className={`w-3.5 h-3.5 ${ecoMode ? 'text-green-400' : 'text-gray-500'}`} />
                      <span className={`text-xs font-medium ${ecoMode ? 'text-green-400' : 'text-gray-400'}`}>
                        Eco-Modus
                      </span>
                    </div>
                    <span className="text-xs text-gray-600">
                      {mode === 'radius' ? '(nur Zentrum, kein Raster)' : '(nur kreisfreie Städte)'}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="flex items-center gap-2.5">
                <label className="text-xs font-medium text-gray-400 whitespace-nowrap">Max. Leads:</label>
                <input
                  type="number"
                  min="0"
                  value={maxLeads || ''}
                  onChange={e => setMaxLeads(Math.max(0, parseInt(e.target.value) || 0))}
                  placeholder="∞ unbegrenzt"
                  className="w-36 bg-black/50 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:ring-1 focus:ring-orange-500 focus:border-orange-500 outline-none transition-all placeholder-gray-600"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              {isSearching ? (
                <button
                  onClick={handleStop}
                  className="bg-red-500/10 text-red-500 border border-red-500/20 hover:bg-red-500/20 px-6 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 transition-all"
                >
                  <Square className="w-4 h-4 fill-current" /> Aufgabe stoppen
                </button>
              ) : (
                <button
                  onClick={handleStart}
                  className="bg-orange-600 hover:bg-orange-500 text-white shadow-[0_0_20px_rgba(249,115,22,0.4)] px-8 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 transition-all"
                >
                  <Play className="w-4 h-4 fill-current" /> Aufgabe ausführen
                </button>
              )}
            </div>
          </section>

          {/* Output Area */}
          <section className="flex-1 flex flex-col min-h-[400px] bg-[#111] border border-white/10 rounded-xl overflow-hidden shadow-2xl">
            <div className="flex border-b border-white/10 bg-[#0a0a0a]">
              <button
                onClick={() => setActiveTab('terminal')}
                className={`px-6 py-3 text-sm font-medium flex items-center gap-2 border-b-2 transition-all ${activeTab === 'terminal' ? 'border-orange-500 text-orange-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
              >
                <Terminal className="w-4 h-4" /> Live-Terminal
              </button>
              <button
                onClick={() => setActiveTab('results')}
                className={`px-6 py-3 text-sm font-medium flex items-center gap-2 border-b-2 transition-all ${activeTab === 'results' ? 'border-orange-500 text-orange-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
              >
                <TableIcon className="w-4 h-4" /> Ergebnisse ({filteredResults.length})
              </button>
              <div className="flex-1 flex justify-end items-center px-4 gap-3">
                {activeTab === 'results' && results.length > 0 && (
                  <>
                    <div className="flex items-center gap-2 mr-2">
                      <input
                        type="checkbox"
                        id="requireFullData"
                        checked={requireFullData}
                        onChange={(e) => setRequireFullData(e.target.checked)}
                        className="accent-orange-500 w-4 h-4 rounded border-white/10 bg-black/50 cursor-pointer"
                      />
                      <label htmlFor="requireFullData" className="text-xs text-gray-400 cursor-pointer select-none hover:text-gray-300">
                        Nur vollständige Daten
                      </label>
                    </div>
                    <button
                      onClick={exportCSV}
                      className="text-xs flex items-center gap-1 bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded text-gray-300 transition-colors"
                    >
                      <Download className="w-3 h-3" /> CSV
                    </button>
                    <button
                      onClick={exportXLSX}
                      className="text-xs flex items-center gap-1 bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded text-gray-300 transition-colors"
                    >
                      <Download className="w-3 h-3" /> XLSX
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="flex-1 relative">
              {activeTab === 'terminal' ? (
                <div className="absolute inset-0 bg-[#050505] p-4 overflow-y-auto font-mono text-xs leading-relaxed">
                  {logs.length === 0 && !isSearching && (
                    <div className="text-gray-600 italic">System bereit. Warte auf Aufgabenausführung...</div>
                  )}
                  {logs.map((log) => (
                    <div key={log.id} className="mb-1 flex gap-3">
                      <span className="text-gray-600 shrink-0">[{log.timestamp.toLocaleTimeString()}]</span>
                      <span className={`
                        ${log.type === 'error' ? 'text-red-400' : ''}
                        ${log.type === 'info' ? 'text-green-400/80' : ''}
                        ${log.type === 'result' ? 'text-orange-400' : ''}
                        ${log.type === 'done' ? 'text-yellow-400 font-bold' : ''}
                      `}>
                        {log.message}
                        {log.data && <span className="text-gray-400 ml-2">{JSON.stringify({ ...log.data, homepage_inhalt: undefined })}</span>}
                      </span>
                    </div>
                  ))}
                  {isSearching && (
                    <div className="flex items-center gap-2 text-green-400/50 mt-2">
                      <span className="animate-pulse">_</span> verarbeite...
                    </div>
                  )}
                  <div ref={logsEndRef} />
                </div>
              ) : (
                <div className="absolute inset-0 overflow-auto bg-[#0a0a0a]">
                  {results.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-gray-500 text-sm">
                      Noch keine Ergebnisse.
                    </div>
                  ) : (
                    <table className="w-full text-left text-xs whitespace-nowrap">
                      <thead className="sticky top-0 bg-[#111] text-gray-400 uppercase tracking-wider border-b border-white/10">
                        <tr>
                          <th className="px-4 py-3 font-medium">Unternehmen</th>
                          <th className="px-4 py-3 font-medium">Branche</th>
                          <th className="px-4 py-3 font-medium">PLZ</th>
                          <th className="px-4 py-3 font-medium">Bundesland</th>
                          <th className="px-4 py-3 font-medium">Kreis</th>
                          <th className="px-4 py-3 font-medium">Rating</th>
                          <th className="px-4 py-3 font-medium">Bewertungen</th>
                          <th className="px-4 py-3 font-medium">Anrede</th>
                          <th className="px-4 py-3 font-medium">Vorname</th>
                          <th className="px-4 py-3 font-medium">Nachname</th>
                          <th className="px-4 py-3 font-medium">Telefon</th>
                          <th className="px-4 py-3 font-medium">E-Mail</th>
                          <th className="px-4 py-3 font-medium">Webseite</th>
                          <th className="px-4 py-3 font-medium">Adresse</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {filteredResults.map((r, i) => (
                          <tr key={i} className="hover:bg-white/5 transition-colors">
                            <td className="px-4 py-3 text-white font-medium">{r.companyName || r.name}</td>
                            <td className="px-4 py-3 text-gray-300">{r.branche || r.industry || '-'}</td>
                            <td className="px-4 py-3 text-gray-300">{r.plz || '-'}</td>
                            <td className="px-4 py-3 text-gray-300">{r.bundesland || '-'}</td>
                            <td className="px-4 py-3 text-gray-300">{r.kreis || '-'}</td>
                            <td className="px-4 py-3 text-gray-300">{r.rating || '-'}</td>
                            <td className="px-4 py-3 text-gray-300">{r.user_ratings_total || '-'}</td>
                            <td className="px-4 py-3 text-gray-300">{r.anrede || '-'}</td>
                            <td className="px-4 py-3 text-gray-300">{r.vorname || '-'}</td>
                            <td className="px-4 py-3 text-gray-300">{r.nachname || '-'}</td>
                            <td className="px-4 py-3 text-gray-300">{r.phone || '-'}</td>
                            <td className="px-4 py-3 text-orange-400">{r.email || '-'}</td>
                            <td className="px-4 py-3 text-orange-400">
                              {r.website ? <a href={r.website} target="_blank" rel="noreferrer" className="hover:underline">Link</a> : '-'}
                            </td>
                            <td className="px-4 py-3 text-gray-400">{r.address}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          </section>

        </div>
      </main>
    </div>
  );
}
