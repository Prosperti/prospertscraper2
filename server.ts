import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { EventEmitter } from 'events';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LANDKREIS_DATA: Record<string, string[]> = {
  "München": ["Garching", "Ismaning", "Unterföhring", "Haar", "Putzbrunn", "Grünwald", "Planegg", "Pullach", "Taufkirchen", "Unterhaching"],
  "Starnberg": ["Starnberg", "Gauting", "Herrsching", "Tutzing", "Gilching", "Krailling", "Pöcking", "Seefeld"],
  "Ebersberg": ["Ebersberg", "Grafing", "Vaterstetten", "Zorneding", "Poing", "Markt Schwaben", "Kirchseeon"],
  "Freising": ["Freising", "Moosburg", "Neufahrn", "Eching", "Hallbergmoos", "Zolling", "Kranzberg"],
  "Dachau": ["Dachau", "Karlsfeld", "Markt Indersdorf", "Petershausen", "Bergkirchen", "Erdweg"],
  "Erding": ["Erding", "Dorfen", "Taufkirchen (Vils)", "Finsing", "Fraunberg", "Wartenberg"]
};

interface JobState {
  emitter: EventEmitter;
  results: any[];
  logs: any[];
  isDone: boolean;
}

const jobs = new Map<string, JobState>();

// PLZ lookup map loaded from PLZ/PLZprufung.xlsx
const plzLookup = new Map<string, { bundesland: string; kreis: string; typ: string }>();

function loadPlzData() {
  const filePath = path.join(process.cwd(), 'PLZ', 'PLZprufung.xlsx');
  if (!fs.existsSync(filePath)) {
    console.log('PLZ/PLZprufung.xlsx nicht gefunden - PLZ-Verifizierung deaktiviert');
    return;
  }
  try {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<any>(sheet);
    for (const row of rows) {
      const plzRaw = row['PLZ'] ?? row['plz'] ?? '';
      const plz = String(plzRaw).padStart(5, '0');
      const bundesland = String(row['Bundesland'] ?? row['bundesland'] ?? '');
      const kreis = String(row['Kreis'] ?? row['kreis'] ?? '');
      const typ = String(row['Typ'] ?? row['typ'] ?? '');
      if (plz && plz !== '00000') {
        plzLookup.set(plz, { bundesland, kreis, typ });
      }
    }
    console.log(`${plzLookup.size} PLZ-Einträge für Verifizierung geladen`);
  } catch (e) {
    console.error('PLZprufung.xlsx konnte nicht geladen werden:', e);
  }
}

function extractPlzFromAddress(address: string): string {
  const match = address.match(/\b(\d{5})\b/);
  return match ? match[1] : '';
}

async function startServer() {
  loadPlzData();

  const app = express();
  const PORT = 3000;

  app.use(express.json());

  app.get('/api/landkreise', (req, res) => {
    res.json(Object.keys(LANDKREIS_DATA));
  });

  app.post('/api/start-job', (req, res) => {
    const jobId = Math.random().toString(36).substring(7);
    const emitter = new EventEmitter();
    const jobState: JobState = { emitter, results: [], logs: [], isDone: false };
    jobs.set(jobId, jobState);

    processJob(jobId, req.body, jobState).catch(err => {
      emitter.emit('log', { type: 'error', message: err.message });
      emitter.emit('done');
    });

    res.json({ jobId });
  });

  // Returns whether a job is still active (used for page-refresh cache reconnect)
  app.get('/api/job-status', (req, res) => {
    const { jobId } = req.query;
    const jobState = jobs.get(jobId as string);
    if (!jobState) {
      return res.json({ exists: false });
    }
    res.json({
      exists: true,
      isDone: jobState.isDone,
      resultCount: jobState.results.length,
      logCount: jobState.logs.length
    });
  });

  app.get('/api/history', (req, res) => {
    const historyDir = path.join(process.cwd(), 'data', 'history');
    const indexFile = path.join(historyDir, 'index.json');
    if (!fs.existsSync(indexFile)) {
      return res.json([]);
    }
    try {
      const data = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: 'Failed to read history index' });
    }
  });

  app.get('/api/history/:id', (req, res) => {
    const { id } = req.params;
    const dataPath = path.join(process.cwd(), 'data', 'history', `${id}.json`);
    if (!fs.existsSync(dataPath)) {
      return res.status(404).json({ error: 'History not found' });
    }
    try {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: 'Failed to read history data' });
    }
  });

  app.get('/api/job-stream', (req, res) => {
    const { jobId, lastResultCount, lastLogCount } = req.query;
    const jobState = jobs.get(jobId as string);

    if (!jobState) return res.status(404).end();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const clientResultCount = parseInt(lastResultCount as string) || 0;
    const clientLogCount = parseInt(lastLogCount as string) || 0;

    for (let i = clientResultCount; i < jobState.results.length; i++) {
      res.write(`data: ${JSON.stringify({ type: 'result', data: jobState.results[i] })}\n\n`);
    }

    for (let i = clientLogCount; i < jobState.logs.length; i++) {
      res.write(`data: ${JSON.stringify(jobState.logs[i])}\n\n`);
    }

    if (jobState.isDone) {
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }

    const onLog = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    jobState.emitter.on('log', onLog);
    jobState.emitter.on('done', () => {
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      setTimeout(() => jobs.delete(jobId as string), 5 * 60 * 1000);
    });

    req.on('close', () => {
      jobState.emitter.off('log', onLog);
    });
  });

  async function processJob(jobId: string, config: any, jobState: JobState) {
    const emitter = jobState.emitter;
    await new Promise(resolve => setTimeout(resolve, 500));

    const log = (msg: string, data?: any) => {
      const logEntry = { type: 'info', message: msg, ...data };
      jobState.logs.push(logEntry);
      emitter.emit('log', logEntry);
    };
    const addResult = (result: any) => {
      jobState.results.push(result);
      emitter.emit('log', { type: 'result', data: result });
    };

    const { industry, industries, mode, city, lat, lng, radius, plzEntries, maxLeads, ecoMode } = config;
    const apiKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
    const maxLeadsLimit: number = (typeof maxLeads === 'number' && maxLeads > 0) ? maxLeads : Infinity;
    const maxPagesPerPoint = 3;

    const searchIndustries = Array.isArray(industries) && industries.length > 0
      ? industries
      : (industry ? [industry] : []);

    if (searchIndustries.length === 0) {
      log('Fehler: Keine Branche angegeben.');
      emitter.emit('done');
      return;
    }

    if (!apiKey) {
      log('Fehler: Google Maps API-Schlüssel fehlt.');
      emitter.emit('done');
      return;
    }

    let pointsToSearch: {lat?: number, lng?: number, query: string, industry?: string, plz?: string, kreis?: string}[] = [];

    if (mode === 'radius') {
      let searchLat = lat;
      let searchLng = lng;

      if ((!searchLat || !searchLng) && city) {
        log(`Geocoding: ${city}...`);
        try {
          const geoResponse = await axios.get(`https://nominatim.openstreetmap.org/search`, {
            params: { q: city, format: 'json', limit: 1 },
            headers: { 'User-Agent': 'LeadGenPro/1.0' }
          });
          if (geoResponse.data && geoResponse.data.length > 0) {
            searchLat = parseFloat(geoResponse.data[0].lat);
            searchLng = parseFloat(geoResponse.data[0].lon);
            log(`Geocoded: ${searchLat}, ${searchLng}`);
          } else {
            throw new Error('Stadt nicht gefunden.');
          }
        } catch (err) {
          throw new Error('Geocoding fehlgeschlagen.');
        }
      }

      const searchRadiusKm = radius || 10;

      if (ecoMode) {
        log(`Eco-Modus aktiv: Suche nur im Zentrum (${searchLat?.toFixed(4)}, ${searchLng?.toFixed(4)}).`);
        for (const ind of searchIndustries) {
          pointsToSearch.push({ lat: searchLat, lng: searchLng, query: ind, industry: ind });
        }
      } else {
        log(`Erzeuge Suchgitter für Radius ${searchRadiusKm}km um ${searchLat}, ${searchLng}...`);
        for (const ind of searchIndustries) {
          pointsToSearch.push({ lat: searchLat, lng: searchLng, query: ind, industry: ind });

          if (searchRadiusKm > 2) {
            const maxGridPoints = Math.max(4, Math.floor(searchRadiusKm));
            const requiredStepKm = Math.sqrt((Math.PI * searchRadiusKm * searchRadiusKm) / maxGridPoints);
            const stepKm = Math.max(3.0, requiredStepKm);

            const steps = Math.ceil(searchRadiusKm / stepKm);
            const latStep = stepKm / 111.32;
            const lngStep = stepKm / (111.32 * Math.cos(searchLat * Math.PI / 180));

            for (let dx = -steps; dx <= steps; dx++) {
              for (let dy = -steps; dy <= steps; dy++) {
                if (dx === 0 && dy === 0) continue;
                const distKm = Math.sqrt(dx*dx + dy*dy) * stepKm;
                if (distKm <= searchRadiusKm) {
                  pointsToSearch.push({
                    lat: searchLat + dx * latStep,
                    lng: searchLng + dy * lngStep,
                    query: ind,
                    industry: ind
                  });
                }
              }
            }
          }
        }
        log(`${pointsToSearch.length} Suchpunkte erzeugt.`);
      }
    } else if (mode === 'landkreis') {
      let entries: { plz: string; kreis: string; bundesland: string }[] = Array.isArray(plzEntries) ? plzEntries : [];
      if (entries.length === 0) {
        log('Fehler: Keine PLZ-Einträge erhalten.');
        emitter.emit('done');
        return;
      }

      // Eco mode for Bundesland: filter to only kreisfreie Städte (Typ='Stadt' in PLZprufung.xlsx)
      if (ecoMode && entries.length > 1) {
        const stadtEntries = entries.filter(e => plzLookup.get(e.plz)?.typ === 'Stadt');
        if (stadtEntries.length > 0) {
          log(`Eco-Modus: ${stadtEntries.length} von ${entries.length} Einträgen ausgewählt (nur kreisfreie Städte).`);
          entries = stadtEntries;
        } else {
          log(`Eco-Modus: Keine kreisfreien Städte gefunden, nutze alle ${entries.length} Einträge.`);
        }
      } else {
        log(`Landkreis-Modus: ${entries.length} PLZ-Eintr${entries.length === 1 ? 'ag' : 'äge'} ausgewählt.`);
      }

      for (const ind of searchIndustries) {
        for (const entry of entries) {
          pointsToSearch.push({ query: `${ind} ${entry.plz}`, industry: ind, plz: entry.plz, kreis: entry.kreis });
        }
      }
    }

    const seenPlaceIds = new Set<string>();
    let stopped = false;

    for (let i = 0; i < pointsToSearch.length; i++) {
      if (stopped) break;
      const point = pointsToSearch[i];

      if (point.lat !== undefined && point.lng !== undefined) {
        log(`[${i+1}/${pointsToSearch.length}] Suche: "${point.query}" @ ${point.lat.toFixed(4)},${point.lng.toFixed(4)}`);
      } else {
        const loc = point.kreis ? ` | Kreis: ${point.kreis}, PLZ: ${point.plz}` : '';
        log(`[${i+1}/${pointsToSearch.length}] Suche: "${point.query}"${loc}`);
      }
      console.log(`[JOB ${jobId}][${i+1}/${pointsToSearch.length}] QUERY: "${point.query}"`);

      const newPlaces: any[] = [];

      try {
        let nextPageToken = '';
        let pagesFetched = 0;

        do {
          let placesResponse;
          let retries = 0;
          while (retries < 3) {
            placesResponse = await axios.get(`https://maps.googleapis.com/maps/api/place/textsearch/json`, {
              params: {
                query: point.query,
                key: apiKey,
                language: 'de',
                location: point.lat !== undefined && point.lng !== undefined ? `${point.lat},${point.lng}` : undefined,
                radius: mode === 'radius' ? 5000 : undefined,
                ...(nextPageToken ? { pagetoken: nextPageToken } : {})
              }
            });

            if (placesResponse.data.status === 'INVALID_REQUEST' && nextPageToken) {
              await new Promise(resolve => setTimeout(resolve, 2000));
              retries++;
            } else {
              break;
            }
          }

          const results = placesResponse?.data?.results || [];
          let newCount = 0;
          for (const place of results) {
            if (!seenPlaceIds.has(place.place_id)) {
              seenPlaceIds.add(place.place_id);
              newPlaces.push({ ...place, _industry: point.industry });
              newCount++;
            }
          }

          log(`  -> ${newCount} neue Orte auf Seite ${pagesFetched + 1}`);

          nextPageToken = placesResponse?.data?.next_page_token;
          pagesFetched++;

          if (nextPageToken) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        } while (nextPageToken && pagesFetched < maxPagesPerPoint);

      } catch (err) {
        log(`  -> Suche fehlgeschlagen für "${point.query}"`);
      }

      log(`  -> ${newPlaces.length} neue Orte gefunden, starte Analyse...`);

      // Process each place immediately (interleaved: search → scrape → add → next point)
      for (let j = 0; j < newPlaces.length; j++) {
        if (stopped) break;
        const place = newPlaces[j];
        log(`  [${j+1}/${newPlaces.length}] Analysiere: ${place.name}`);

        let website = '';
        let phone = '';
        const address = place.formatted_address || '';

        if (place.place_id) {
          try {
            const detailsResponse = await axios.get(`https://maps.googleapis.com/maps/api/place/details/json`, {
              params: {
                place_id: place.place_id,
                fields: 'website,formatted_phone_number',
                key: apiKey
              }
            });
            website = detailsResponse.data.result?.website || '';
            phone = detailsResponse.data.result?.formatted_phone_number || '';
          } catch (err) {
            // ignore
          }
        }

        let aiData = null;
        if (website) {
          log(`  -> Scraping: ${website}`);
          aiData = await analyzeWebsite(website);
          if (aiData) {
            log(`  -> Extrahiert: ${aiData.firstName} ${aiData.lastName}, ${aiData.email}`);
          } else {
            log(`  -> Keine Daten von Website extrahiert.`);
          }
        } else {
          log(`  -> Keine Website gefunden.`);
        }

        // PLZ verification against PLZprufung.xlsx
        const plz = extractPlzFromAddress(address);
        const plzInfo = plz ? plzLookup.get(plz) : undefined;

        const resultObj = {
          id: place.place_id,
          companyName: aiData?.companyName || place.name,
          branche: place._industry || '',
          anrede: aiData?.salutation || '',
          vorname: aiData?.firstName || '',
          nachname: aiData?.lastName || '',
          phone: aiData?.phone || phone || '',
          email: aiData?.email || '',
          website: website,
          address: address,
          plz: plz || '',
          bundesland: plzInfo?.bundesland || '',
          kreis: plzInfo?.kreis || '',
          status: place.business_status || 'OPERATIONAL',
          rating: place.rating || '',
          user_ratings_total: place.user_ratings_total || '',
          homepage_inhalt: aiData?.homepage_inhalt || ''
        };

        addResult(resultObj);

        if (jobState.results.length >= maxLeadsLimit) {
          log(`✅ Maximale Anzahl von ${maxLeads} Leads erreicht. Scraping wird beendet.`);
          stopped = true;
        }
      }
    }

    log('Job erfolgreich abgeschlossen.');
    try {
      const historyDir = path.join(process.cwd(), 'data', 'history');
      if (!fs.existsSync(historyDir)) {
        fs.mkdirSync(historyDir, { recursive: true });
      }
      const indexFile = path.join(historyDir, 'index.json');
      let historyIndex = [];
      if (fs.existsSync(indexFile)) {
        historyIndex = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
      }

      const searchId = Date.now().toString();
      const meta = {
        id: searchId,
        timestamp: Date.now(),
        date: new Date().toISOString().split('T')[0],
        config: {
          industries: searchIndustries,
          mode,
          city,
          radius,
          plzLabel: Array.isArray(plzEntries) && plzEntries.length > 0
            ? (plzEntries.length === 1
              ? `${plzEntries[0].kreis} (${plzEntries[0].plz})`
              : `${plzEntries[0].bundesland} (${plzEntries.length} PLZ)`)
            : ''
        },
        resultCount: jobState.results.length
      };

      historyIndex.unshift(meta);
      fs.writeFileSync(indexFile, JSON.stringify(historyIndex, null, 2));
      fs.writeFileSync(path.join(historyDir, `${searchId}.json`), JSON.stringify(jobState.results, null, 2));
    } catch (e) {
      console.error('Verlaufsspeicherung fehlgeschlagen:', e);
    }
    jobState.isDone = true;
    emitter.emit('done');
  }

  async function analyzeWebsite(url: string) {
    try {
      let targetUrl = url;
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
      }

      const fetchPage = async (pageUrl: string): Promise<{html: string, text: string, ok: boolean}> => {
        try {
          const response = await axios.get(pageUrl, {
            timeout: 8000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            maxRedirects: 3
          });
          const html = response.data;
          const $ = cheerio.load(html);
          $('script, style, noscript, iframe, img, svg, video').remove();
          return { html, text: $('body').text(), ok: true };
        } catch (e) {
          return { html: '', text: '', ok: false };
        }
      };

      const homeData = await fetchPage(targetUrl);
      if (!homeData.ok) return null;

      const $home = cheerio.load(homeData.html);
      const internalLinks = new Set<string>();
      $home('a[href]').each((_, el) => {
        let href = $home(el).attr('href');
        if (!href) return;
        if (href.startsWith('/') || href.includes(new URL(targetUrl).hostname)) {
           try {
             const absUrl = new URL(href, targetUrl).href;
             if (!absUrl.match(/\.(pdf|jpg|png|gif|zip|doc)$/i)) {
               internalLinks.add(absUrl.split('#')[0]);
             }
           } catch(e){}
        }
      });

      const linksArray = Array.from(internalLinks);
      const imprintLink = linksArray.find(l => /impressum|imprint|legal/i.test(l)) || `${targetUrl}/impressum`;
      const contactLink = linksArray.find(l => /kontakt|contact/i.test(l)) || `${targetUrl}/kontakt`;

      const pagesData = await Promise.all([imprintLink, contactLink].map(l => fetchPage(l)));

      let combinedText = homeData.text;
      for (const page of pagesData) {
        if (page.ok) combinedText += '\n' + page.text;
      }

      combinedText = combinedText.replace(/\s+/g, ' ');
      combinedText = combinedText.replace(/\[email\s*protected\]/gi, '');
      combinedText = combinedText.replace(/\(email\s*protected\)/gi, '');
      combinedText = combinedText.replace(/\s*\[at\]\s*/gi, '@');
      combinedText = combinedText.replace(/\s*\(at\)\s*/gi, '@');
      combinedText = combinedText.replace(/\s*\{at\}\s*/gi, '@');
      combinedText = combinedText.replace(/\s*\[dot\]\s*/gi, '.');
      combinedText = combinedText.replace(/\s*\(dot\)\s*/gi, '.');
      combinedText = combinedText.replace(/\s*\{dot\}\s*/gi, '.');

      const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
      const emails: string[] = combinedText.match(emailRegex) || [];
      const validEmails = emails.filter(e => !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.jpeg') && !e.endsWith('.gif'));
      let email = validEmails.find(e => /info|kontakt|hello|office/i.test(e)) || validEmails[0] || '';

      const phoneRegex = /(?:(?:\+|00)49|0)[1-9][0-9 \-\/\(\)]{5,15}/g;
      const phones = combinedText.match(phoneRegex) || [];
      let phone = phones.length > 0 ? phones[0].trim() : '';

      let firstName = '';
      let lastName = '';
      let salutation = '';
      let companyName = '';

      try {
        const OpenAI = (await import('openai')).default;
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const prompt = `Extrahiere die folgenden Daten aus diesem Text (Impressum/Kontakt).
Achte darauf, E-Mail-Adressen zu korrigieren, falls sie maskiert sind (z.B. "info (at) domain.de" -> "info@domain.de"). Ignoriere "email protected".
Antworte AUSSCHLIESSLICH im JSON-Format mit den Schlüsseln:
- "companyName": Firmenname
- "anrede": "Herr" oder "Frau" (basierend auf dem Vornamen oder Text, leer falls nicht gefunden)
- "vorname": Vorname des Geschäftsführers/Inhabers
- "nachname": Nachname des Geschäftsführers/Inhabers
- "phone": Telefonnummer
- "email": E-Mail Adresse

Text:
${combinedText.substring(0, 6000)}`;

        const response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.1
        });

        if (response.choices[0].message.content) {
          const result = JSON.parse(response.choices[0].message.content);
          firstName = result.vorname || '';
          lastName = result.nachname || '';
          salutation = result.anrede || '';
          companyName = result.companyName || '';
          if (result.phone) phone = result.phone;
          if (result.email) email = result.email;
        }
      } catch (e) {
        console.error("OpenAI-Extraktion fehlgeschlagen:", e);
      }

      return {
        salutation,
        firstName,
        lastName,
        companyName,
        email,
        phone,
        homepage_inhalt: homeData.text.replace(/\s+/g, ' ').trim()
      };

    } catch (error: any) {
      console.error('Fehler bei Website-Analyse:', error);
      return null;
    }
  }

  app.post('/api/search-places', async (req, res) => {
    try {
      const { industry, city, lat, lng, radius } = req.body;
      const apiKey = process.env.VITE_GOOGLE_MAPS_API_KEY;

      if (!apiKey) {
        return res.status(500).json({ error: 'Google Maps API key is missing on the server.' });
      }

      let searchLat = lat;
      let searchLng = lng;

      if ((!searchLat || !searchLng) && city) {
        try {
          const geoResponse = await axios.get(`https://nominatim.openstreetmap.org/search`, {
            params: { q: city, format: 'json', limit: 1 },
            headers: { 'User-Agent': 'LeadGenPro/1.0' }
          });
          if (geoResponse.data && geoResponse.data.length > 0) {
            searchLat = parseFloat(geoResponse.data[0].lat);
            searchLng = parseFloat(geoResponse.data[0].lon);
          } else {
            return res.status(400).json({ error: 'City could not be found.' });
          }
        } catch (err) {
          console.error('Geocoding failed:', err);
        }
      }

      if (!searchLat || !searchLng) {
        return res.status(400).json({ error: 'Could not determine search location.' });
      }

      const searchRadiusKm = radius || 10;
      const searchRadiusMeters = searchRadiusKm * 1000;

      const pointsToSearch: {lat: number, lng: number}[] = [];
      pointsToSearch.push({ lat: searchLat, lng: searchLng });

      let apiSearchRadiusMeters = searchRadiusMeters;

      if (searchRadiusKm > 2) {
        const maxGridPoints = Math.max(4, Math.floor(searchRadiusKm));
        const requiredStepKm = Math.sqrt((Math.PI * searchRadiusKm * searchRadiusKm) / maxGridPoints);
        const stepKm = Math.max(3.0, requiredStepKm);

        apiSearchRadiusMeters = Math.ceil(stepKm * 1000 * 0.75);

        const steps = Math.ceil(searchRadiusKm / stepKm);
        const latStep = stepKm / 111.32;
        const lngStep = stepKm / (111.32 * Math.cos(searchLat * Math.PI / 180));

        for (let dx = -steps; dx <= steps; dx++) {
          for (let dy = -steps; dy <= steps; dy++) {
            if (dx === 0 && dy === 0) continue;
            const distKm = Math.sqrt(dx*dx + dy*dy) * stepKm;
            if (distKm <= searchRadiusKm) {
              pointsToSearch.push({
                lat: searchLat + dx * latStep,
                lng: searchLng + dy * lngStep
              });
            }
          }
        }

        if (pointsToSearch.length > maxGridPoints) {
           const center = pointsToSearch[0];
           const others = pointsToSearch.slice(1);
           others.sort((a, b) => {
             const distA = Math.pow(a.lat - center.lat, 2) + Math.pow(a.lng - center.lng, 2);
             const distB = Math.pow(b.lat - center.lat, 2) + Math.pow(b.lng - center.lng, 2);
             return distA - distB;
           });
           pointsToSearch.splice(1, pointsToSearch.length - 1, ...others.slice(0, maxGridPoints - 1));
        }
      }

      const allResults: any[] = [];
      const seenPlaceIds = new Set<string>();

      for (const point of pointsToSearch) {
        const query = (pointsToSearch.length > 1) ? industry : (city ? `${industry} in ${city}` : industry);
        try {
          let nextPageToken = '';
          let pagesFetched = 0;

          do {
            let placesResponse;
            let retries = 0;
            while (retries < 3) {
              placesResponse = await axios.get(`https://maps.googleapis.com/maps/api/place/textsearch/json`, {
                params: {
                  query,
                  key: apiKey,
                  language: 'de',
                  location: `${point.lat},${point.lng}`,
                  radius: apiSearchRadiusMeters,
                  ...(nextPageToken ? { pagetoken: nextPageToken } : {})
                }
              });

              if (placesResponse.data.status === 'INVALID_REQUEST' && nextPageToken) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                retries++;
              } else {
                break;
              }
            }

            const results = placesResponse?.data?.results || [];
            for (const place of results) {
              if (!seenPlaceIds.has(place.place_id)) {
                seenPlaceIds.add(place.place_id);
                allResults.push(place);
              }
            }

            nextPageToken = placesResponse?.data?.next_page_token;
            pagesFetched++;

            if (nextPageToken) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          } while (nextPageToken && pagesFetched < 3);

        } catch (err) {
          console.error(`Search failed for location ${point.lat},${point.lng}`);
        }
      }

      const detailedCompanies = [];
      const batchSize = 10;

      for (let i = 0; i < allResults.length; i += batchSize) {
        const batch = allResults.slice(i, i + batchSize);
        const batchPromises = batch.map(async (place, index) => {
          let website = '';
          let phone = '';
          let address = place.formatted_address || '';
          let zip = '';
          let placeCity = '';

          const addressParts = address.split(',');
          if (addressParts.length >= 2) {
            const zipCityPart = addressParts[addressParts.length - 2].trim();
            const zipMatch = zipCityPart.match(/\d{5}/);
            if (zipMatch) {
              zip = zipMatch[0];
              placeCity = zipCityPart.replace(zip, '').trim();
            }
          }

          if (place.place_id) {
            try {
              const detailsResponse = await axios.get(`https://maps.googleapis.com/maps/api/place/details/json`, {
                params: {
                  place_id: place.place_id,
                  fields: 'website,formatted_phone_number',
                  key: apiKey
                }
              });
              website = detailsResponse.data.result?.website || '';
              phone = detailsResponse.data.result?.formatted_phone_number || '';
            } catch (err) {
              console.error(`Failed to fetch details for place ${place.place_id}`);
            }
          }

          return {
            id: place.place_id || `temp-${i}-${index}`,
            name: place.name,
            branche: industry,
            address: address.split(',')[0],
            zip: zip,
            city: placeCity || city,
            fullAddress: address,
            phone: phone,
            website: website,
            googleMapsLink: `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
            reviewCount: place.user_ratings_total || 0,
            rating: place.rating || 0,
            status: place.business_status || 'OPERATIONAL',
            source: 'Google Places'
          };
        });

        const resolvedBatch = await Promise.all(batchPromises);
        detailedCompanies.push(...resolvedBatch);
      }

      res.json({
        companies: detailedCompanies,
        resolvedLocation: { lat: searchLat, lng: searchLng }
      });

    } catch (error: any) {
      console.error('Error searching places:', error?.response?.data || error.message);
      res.status(500).json({ error: 'Failed to search places' });
    }
  });

  app.post('/api/analyze-website', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }

      console.log(`Analyzing website: ${url}`);

      let targetUrl = url;
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
      }

      const fetchPage = async (pageUrl: string): Promise<{html: string, text: string, ok: boolean}> => {
        try {
          const response = await axios.get(pageUrl, {
            timeout: 8000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
              'Accept-Language': 'de,en-US;q=0.7,en;q=0.3'
            },
            maxRedirects: 3
          });
          const html = response.data;
          const $ = cheerio.load(html);
          $('script, style, noscript, iframe, img, svg, video').remove();
          return { html, text: $('body').text(), ok: true };
        } catch (e) {
          return { html: '', text: '', ok: false };
        }
      };

      const homeData = await fetchPage(targetUrl);
      if (!homeData.ok) {
        console.error(`Failed to fetch homepage ${targetUrl}`);
        return res.status(404).json({ error: 'Website not reachable', status: 404 });
      }

      const $home = cheerio.load(homeData.html);

      let favicon = $home('link[rel="icon"]').attr('href') || $home('link[rel="shortcut icon"]').attr('href') || $home('link[rel="apple-touch-icon"]').attr('href');
      if (favicon && !favicon.startsWith('http')) {
        try {
          favicon = new URL(favicon, targetUrl).href;
        } catch (e) {
          favicon = '';
        }
      }

      const internalLinks = new Set<string>();
      $home('a[href]').each((_, el) => {
        let href = $home(el).attr('href');
        if (!href) return;
        if (href.startsWith('/') || href.includes(new URL(targetUrl).hostname)) {
           try {
             const absUrl = new URL(href, targetUrl).href;
             if (!absUrl.match(/\.(pdf|jpg|png|gif|zip|doc)$/i)) {
               internalLinks.add(absUrl.split('#')[0]);
             }
           } catch(e){}
        }
      });

      const linksArray = Array.from(internalLinks);
      const imprintLink = linksArray.find(l => /impressum|imprint|legal/i.test(l)) || `${targetUrl}/impressum`;
      const privacyLink = linksArray.find(l => /datenschutz|privacy/i.test(l)) || `${targetUrl}/datenschutz`;
      const contactLink = linksArray.find(l => /kontakt|contact/i.test(l)) || `${targetUrl}/kontakt`;

      const deepLinks = linksArray.filter(l =>
        /team|ueber|about|person|profil|wir/i.test(l) &&
        l !== imprintLink && l !== privacyLink && l !== contactLink
      ).slice(0, 3);

      const pagesToFetch = [imprintLink, privacyLink, contactLink, ...deepLinks];
      const pagesData = await Promise.all(pagesToFetch.map(l => fetchPage(l)));

      let combinedText = homeData.text;
      let combinedHtml = homeData.html;

      for (const page of pagesData) {
        if (page.ok) {
          combinedText += '\n' + page.text;
          combinedHtml += '\n' + page.html;
        }
      }

      combinedText = combinedText.replace(/\s+/g, ' ');
      combinedText = combinedText.replace(/\[email\s*protected\]/gi, '');
      combinedText = combinedText.replace(/\(email\s*protected\)/gi, '');
      combinedText = combinedText.replace(/\s*\[at\]\s*/gi, '@');
      combinedText = combinedText.replace(/\s*\(at\)\s*/gi, '@');
      combinedText = combinedText.replace(/\s*\{at\}\s*/gi, '@');
      combinedText = combinedText.replace(/\s*\[dot\]\s*/gi, '.');
      combinedText = combinedText.replace(/\s*\(dot\)\s*/gi, '.');
      combinedText = combinedText.replace(/\s*\{dot\}\s*/gi, '.');

      const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
      const emails: string[] = combinedText.match(emailRegex) || [];
      const validEmails = emails.filter(e => !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.jpeg') && !e.endsWith('.gif'));
      let email = validEmails.find(e => /info|kontakt|hello|office/i.test(e)) || validEmails[0] || '';

      const phoneRegex = /(?:(?:\+|00)49|0)[1-9][0-9 \-\/\(\)]{5,15}/g;
      const phones = combinedText.match(phoneRegex) || [];
      let phone = phones.length > 0 ? phones[0].trim() : '';

      const linkedinRegex = /https?:\/\/(www\.)?linkedin\.com\/(company|in)\/[a-zA-Z0-9_-]+/i;
      const linkedinMatch = combinedHtml.match(linkedinRegex);
      const linkedinUrl = linkedinMatch ? linkedinMatch[0] : '';

      let firstName = '';
      let lastName = '';
      let salutation = '';

      try {
        const OpenAI = (await import('openai')).default;
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const prompt = `Analysiere den folgenden Text einer Firmenwebsite (Impressum, Kontakt, Über uns).
Finde den Hauptansprechpartner (Geschäftsführer, Inhaber, Vorstand, Praxisinhaber, Tierarzt, etc.).
Achte darauf, E-Mail-Adressen zu korrigieren, falls sie maskiert sind (z.B. "info (at) domain.de" -> "info@domain.de"). Ignoriere "email protected".
Antworte AUSSCHLIESSLICH im JSON-Format mit den Schlüsseln:
- "vorname": Vorname (leer falls nicht gefunden)
- "nachname": Nachname (leer falls nicht gefunden)
- "anrede": "Herr" oder "Frau" (basierend auf dem Vornamen oder Text, leer falls nicht gefunden)
- "phone": Telefonnummer
- "email": E-Mail Adresse

Text (gekürzt):
${combinedText.substring(0, 6000)}`;

        const response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.1
        });

        if (response.choices[0].message.content) {
          const result = JSON.parse(response.choices[0].message.content);
          firstName = result.vorname || '';
          lastName = result.nachname || '';
          salutation = result.anrede || '';
          if (result.phone) phone = result.phone;
          if (result.email) email = result.email;
        }
      } catch (e) {
        console.error("OpenAI extraction failed:", e);
      }

      const inhalt = homeData.text.replace(/\s+/g, ' ').trim().substring(0, 1000);

      res.json({
        salutation,
        firstName,
        lastName,
        email,
        phone,
        linkedinUrl,
        logo: favicon || '',
        favicon: favicon || '',
        inhalt
      });

    } catch (error: any) {
      console.error('Error analyzing website:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = __dirname;
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
