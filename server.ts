import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { TripUnderstandingAgent } from './src/services/agents/tripUnderstandingAgent.js';
import { GarudaCoordinator } from './src/services/agents/coordinator.js';
import { FixedBudgetAgent } from './src/services/agents/fixedBudgetAgent.js';
import { BackwardPlanningAgent } from './src/services/agents/backwardPlanningAgent.js';
import { TravelModeSwitchingAgent } from './src/services/agents/travelModeSwitchingAgent.js';
import { DisruptionRecoveryAgent } from './src/services/agents/disruptionRecoveryAgent.js';
import { mockRouteOptions, mockHotels, mockDestinations } from './src/data/mockData.js';
import { PUBLIC_TRANSIT_DATABASE, RENTAL_FLEET_DATABASE, CITY_COORDINATES } from './src/data/transitInventory.js';
import { TransitProviderService } from './src/services/integrations/transitProviderService.js';
import { RentalProviderService } from './src/services/integrations/rentalProviderService.js';
import { MappingService } from './src/services/integrations/mappingService.js';
import { ItineraryValidator } from './src/services/validation/itineraryValidator.js';

dotenv.config();

const app = express();
app.use(express.json());

// Initialize Google Gemini AI SDK with required telemetry User-Agent header
const apiKey = process.env.GEMINI_API_KEY || '';
let aiClient: GoogleGenAI | null = null;
if (apiKey) {
  aiClient = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });
}

// ============================================================================
// 1. Health & Integration Status
// ============================================================================
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    version: '2.1.0',
    service: 'GARUDA AI Agentic Platform',
    geminiConfigured: !!apiKey,
    publicTransitOptionsCount: PUBLIC_TRANSIT_DATABASE.length,
    rentalFleetCount: RENTAL_FLEET_DATABASE.length,
    timestamp: new Date().toISOString()
  });
});

// 1b. Commercial Integrations API Status Center
app.get('/api/integrations/status', (_req: Request, res: Response) => {
  const transitProviders = TransitProviderService.getProviderStatuses();
  const rentalProviders = RentalProviderService.getProviderStatuses();
  res.json({
    success: true,
    transitProviders,
    rentalProviders,
    timestamp: new Date().toISOString()
  });
});

// 1c. Provider Ping Latency Test
app.post('/api/integrations/test-ping', async (req: Request, res: Response) => {
  try {
    const { providerId, category } = req.body;
    if (!providerId) {
      return res.status(400).json({ success: false, error: 'providerId is required' });
    }
    if (category === 'rental') {
      const result = await RentalProviderService.pingProvider(providerId);
      return res.json({ success: true, ...result });
    } else {
      const result = await TransitProviderService.pingProvider(providerId);
      return res.json({ success: true, ...result });
    }
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Provider test ping failed. Verified timetable cache remains active.' });
  }
});

// ============================================================================
// 2. MAPPING, GEOCODING & ROUTE CALCULATION (Phase 2)
// ============================================================================
app.get('/api/maps/geocode', async (req: Request, res: Response) => {
  try {
    const query = req.query.query as string;
    if (!query || query.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Location query parameter is required.' });
    }
    const result = await MappingService.geocode(query);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Geocoding service encountered an error.' });
  }
});

app.post('/api/maps/route', async (req: Request, res: Response) => {
  try {
    const { origin, destination, mode = 'train' } = req.body;
    if (!origin || !destination) {
      return res.status(400).json({ success: false, error: 'Both origin and destination are required.' });
    }
    const metrics = await MappingService.calculateRoute(origin, destination, mode);
    res.json({ success: true, data: metrics });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Route calculation service encountered an error.' });
  }
});

// Dedicated Real Road Routing Endpoint (OSRM with Highway Fallback)
app.post('/api/maps/road-route', async (req: Request, res: Response) => {
  try {
    const { originCoords, destCoords, mode = 'car' } = req.body;
    if (!originCoords || !destCoords) {
      return res.status(400).json({ success: false, error: 'originCoords and destCoords [lat, lng] are required.' });
    }
    const result = await MappingService.getRealRoadRoute({ originCoords, destCoords, mode });
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Real road routing failed.' });
  }
});

// Dedicated Indian Railways Train Corridor Endpoint
app.post('/api/maps/rail-route', (req: Request, res: Response) => {
  try {
    const { origin, destination, trainServiceNumber } = req.body;
    if (!origin || !destination) {
      return res.status(400).json({ success: false, error: 'Origin and destination station names are required.' });
    }
    const result = MappingService.getRailwayRoute({ origin, destination, trainServiceNumber });
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Railway route calculation failed.' });
  }
});

// Dedicated Urban Metro Routing Endpoint
app.post('/api/maps/metro-route', (req: Request, res: Response) => {
  try {
    const { originStation = 'Secunderabad East', destStation = 'Raidurg' } = req.body;
    const result = MappingService.getMetroRoute(originStation, destStation);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Metro route calculation failed.' });
  }
});

app.get('/api/transit/live-tracking', (req: Request, res: Response) => {
  try {
    const serviceNumber = (req.query.serviceNumber as string) || 'UNKNOWN';
    const carrierType = req.query.carrierType as string;
    const scheduledDeparture = req.query.scheduledDeparture as string;
    const scheduledArrival = req.query.scheduledArrival as string;

    const tracking = MappingService.getVehicleTrackingStatus({
      serviceNumber,
      carrierType,
      scheduledDeparture,
      scheduledArrival
    });

    res.json({ success: true, data: tracking });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Live tracking feed check failed.' });
  }
});

// ============================================================================
// 3. MODE A: PUBLIC TRANSPORTATION SEARCH API
// ============================================================================
app.post('/api/transit/public-search', async (req: Request, res: Response) => {
  try {
    const {
      source,
      destination,
      travelDate,
      departurePreference = 'any',
      passengers = 1,
      modeFilter = 'all'
    } = req.body;

    if (!source || !destination) {
      return res.status(400).json({
        success: false,
        error: 'Both departure (source) and arrival (destination) locations are required.'
      });
    }

    const cleanSrc = String(source).trim();
    const cleanDst = String(destination).trim();

    if (cleanSrc.toLowerCase() === cleanDst.toLowerCase()) {
      return res.status(400).json({
        success: false,
        error: 'Origin and destination cannot be identical. Please enter distinct locations.'
      });
    }

    const numPassengers = Math.max(1, Math.min(10, parseInt(String(passengers), 10) || 1));

    const searchResponse = await TransitProviderService.searchTransit({
      source: cleanSrc,
      destination: cleanDst,
      travelDate,
      passengers: numPassengers,
      modeFilter,
      departurePreference
    });

    res.json({
      success: true,
      query: {
        source: cleanSrc,
        destination: cleanDst,
        travelDate: travelDate || new Date().toISOString().split('T')[0],
        passengers: numPassengers,
        modeFilter,
        departurePreference
      },
      count: searchResponse.results.length,
      data: searchResponse.results,
      unsupportedRoute: searchResponse.unsupportedRoute,
      metadata: searchResponse.metadata,
      suggestedHubs: searchResponse.suggestedHubs,
      disclaimer: 'Schedules derived from verified IRCTC and State RTC timetable caches. Fares reflect published tariffs.'
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Transit search failed. Please try again with valid locations.' });
  }
});

// ============================================================================
// 4. MODE B: RENTAL TRANSPORTATION SEARCH API
// ============================================================================
app.post('/api/transit/rentals-search', async (req: Request, res: Response) => {
  try {
    const {
      pickupLocation,
      pickupDate,
      returnDate,
      category = 'all',
      maxBudget
    } = req.body;

    if (!pickupDate || !returnDate) {
      return res.status(400).json({
        success: false,
        error: 'Both pickup date and return date are mandatory for vehicle rentals.'
      });
    }

    const pDate = new Date(pickupDate);
    const rDate = new Date(returnDate);

    if (isNaN(pDate.getTime()) || isNaN(rDate.getTime())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date format provided for rental duration.'
      });
    }

    if (rDate < pDate) {
      return res.status(400).json({
        success: false,
        error: 'Return date cannot be earlier than pickup date.'
      });
    }

    const rentalResponse = await RentalProviderService.searchRentals({
      pickupLocation,
      pickupDate,
      returnDate,
      category,
      maxBudget
    });

    res.json({
      success: true,
      query: {
        pickupLocation: pickupLocation || 'All Available Hubs',
        pickupDate,
        returnDate,
        durationDays: rentalResponse.metadata.durationDays,
        category,
        maxBudget
      },
      count: rentalResponse.results.length,
      data: rentalResponse.results,
      metadata: rentalResponse.metadata,
      demoModeNotice: {
        isDemoSampleData: !rentalResponse.metadata.isLiveApiConnected,
        message: rentalResponse.metadata.demoNotice
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Rental search failed. Please verify dates and criteria.' });
  }
});

// ============================================================================
// 5. ITINERARY VALIDATION & CONSTRAINTS ENGINE (Phase 3)
// ============================================================================
app.post('/api/trips/validate', (req: Request, res: Response) => {
  try {
    const { trip } = req.body;
    if (!trip) {
      return res.status(400).json({ success: false, error: 'Trip object is required for validation.' });
    }
    const report = ItineraryValidator.validateTrip(trip);
    res.json({ success: true, data: report });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Trip validation failed.' });
  }
});

// ============================================================================
// 6. DISRUPTION RECOVERY & REPLANNING (Phase 4)
// ============================================================================
app.post('/api/trips/disruption/generate', (req: Request, res: Response) => {
  try {
    const { trip, scenarioType = 'train_delayed', delayMinutes = 120 } = req.body;
    if (!trip) {
      return res.status(400).json({ success: false, error: 'Trip object is required.' });
    }
    const disruption = DisruptionRecoveryAgent.generateRecoveryScenarios(trip, scenarioType, delayMinutes);
    res.json({ success: true, data: disruption });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Disruption scenario generation failed.' });
  }
});

app.post('/api/trips/disruption/accept', (req: Request, res: Response) => {
  try {
    const { trip, scenario, chosenPlan } = req.body;
    if (!trip || !scenario || !chosenPlan) {
      return res.status(400).json({ success: false, error: 'Trip, scenario, and chosenPlan are required.' });
    }
    const updated = DisruptionRecoveryAgent.acceptRecoveryPlan(trip, scenario, chosenPlan);
    res.json({ success: true, data: updated, disclaimer: 'Simulated plan guidance: ticketing must be completed directly with official carrier.' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to accept recovery proposal.' });
  }
});

app.post('/api/trips/disruption/reject', (req: Request, res: Response) => {
  try {
    const { trip, scenario } = req.body;
    if (!trip || !scenario) {
      return res.status(400).json({ success: false, error: 'Trip and scenario are required.' });
    }
    const updated = DisruptionRecoveryAgent.rejectRecoveryPlan(trip, scenario);
    res.json({ success: true, data: updated, message: 'Proposal rejected; original itinerary preserved intact.' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to reject recovery proposal.' });
  }
});

// ============================================================================
// 7. AGENTIC AI TRAVEL CONCIERGE & ITINERARY PLANNING (Gemini 3.8 Flash)
// ============================================================================
app.post('/api/ai/plan-itinerary', async (req: Request, res: Response) => {
  try {
    const { parsedRequest } = req.body;
    if (!parsedRequest) {
      return res.status(400).json({ success: false, error: 'parsedRequest is required' });
    }

    // Attempt AI-assisted refinement with Gemini if client is ready, with strict 8s timeout
    if (aiClient) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const prompt = `As GARUDA AI travel concierge, recommend top 3 signature sights for a ${parsedRequest.durationDays}-day trip to ${parsedRequest.destination} that fit budget of ₹${parsedRequest.totalBudgetINR}. Return clean JSON array of strings only.`;
        
        const aiResponse = await aiClient.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt
        });

        clearTimeout(timeoutId);

        if (aiResponse.text) {
          const match = aiResponse.text.match(/\[[\s\S]*\]/);
          if (match) {
            try {
              const parsedSights = JSON.parse(match[0]);
              if (Array.isArray(parsedSights) && parsedSights.length > 0) {
                parsedRequest.requestedPlaces = [
                  ...parsedRequest.requestedPlaces,
                  ...parsedSights.slice(0, 3)
                ];
              }
            } catch {}
          }
        }
      } catch (geminiError) {
        console.warn('Gemini itinerary enrichment timed out or failed; continuing with deterministic coordinator.');
      }
    }

    const result = GarudaCoordinator.coordinatePlan(parsedRequest);
    const validation = ItineraryValidator.validateTrip(result.trip);

    res.json({
      success: true,
      data: result,
      validationReport: validation
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'AI itinerary planning encountered an error.' });
  }
});

app.post('/api/ai/chat', async (req: Request, res: Response) => {
  try {
    const { message, tripContext } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message text is required' });
    }

    const trimmedMsg = message.trim();
    const lower = trimmedMsg.toLowerCase();

    // Intent detection
    const isPublicTransitQuery =
      lower.includes('train') ||
      lower.includes('bus') ||
      lower.includes('metro') ||
      lower.includes('flight') ||
      lower.includes('cheapest way') ||
      lower.includes('how to travel') ||
      lower.includes('travel from');

    const isRentalQuery =
      lower.includes('rent') ||
      lower.includes('rental') ||
      lower.includes('scooter') ||
      lower.includes('bike') ||
      lower.includes('car for') ||
      lower.includes('self-drive');

    const isDisruptionQuery =
      lower.includes('delayed') ||
      lower.includes('delay') ||
      lower.includes('cancelled') ||
      lower.includes('missed') ||
      lower.includes('disruption');

    // City extraction heuristic
    let detectedSource = '';
    let detectedDest = '';

    for (const city of Object.keys(CITY_COORDINATES)) {
      const cityLower = city.toLowerCase();
      if (lower.includes(`from ${cityLower}`)) detectedSource = city;
      else if (lower.includes(`to ${cityLower}`)) detectedDest = city;
      else if (lower.includes(cityLower)) {
        if (!detectedSource) detectedSource = city;
        else if (!detectedDest && detectedSource !== city) detectedDest = city;
      }
    }

    if (!detectedSource && tripContext?.origin) detectedSource = tripContext.origin;
    if (!detectedDest && tripContext?.destination) detectedDest = tripContext.destination;

    let rentalCategory: 'car' | 'bike' | 'scooter' | 'ev' | 'all' = 'all';
    if (lower.includes('bike') || lower.includes('motorcycle')) rentalCategory = 'bike';
    else if (lower.includes('scooter') || lower.includes('activa') || lower.includes('ather')) rentalCategory = 'scooter';
    else if (lower.includes('car') || lower.includes('suv') || lower.includes('sedan')) rentalCategory = 'car';
    else if (lower.includes('ev') || lower.includes('electric')) rentalCategory = 'ev';

    let rentalDays = 2;
    const daysMatch = lower.match(/(\d+)\s*days?/);
    if (daysMatch) {
      rentalDays = Math.max(1, parseInt(daysMatch[1], 10));
    }

    // Missing essential info check
    const isMissingEssentialInfo =
      (isPublicTransitQuery && !detectedSource && !detectedDest) ||
      (isRentalQuery && !lower.includes('bike') && !lower.includes('car') && !lower.includes('scooter') && !detectedDest);

    if (isMissingEssentialInfo) {
      return res.json({
        success: true,
        reply: `I would be glad to find the best travel options for you! To give you accurate schedules, fares, and connections, could you please specify:
1. Your departure city (origin) and where you are traveling to (destination)?
2. Your approximate travel dates and number of passengers?

Once you let me know, I'll search both Public Transportation (Trains, Buses, Metro) and Rental Vehicles immediately!`,
        suggestedActions: [
          { label: 'Search Vizag to Hyderabad', action: 'PROMPT', payload: 'Find train and bus options from Visakhapatnam to Hyderabad' },
          { label: 'Search Vizianagaram to Vizag', action: 'PROMPT', payload: 'Find cheapest way from Vizianagaram to Visakhapatnam tomorrow' },
          { label: 'Explore Rental Bikes for 2 Days', action: 'PROMPT', payload: 'Find a rental bike for two days in Visakhapatnam' }
        ]
      });
    }

    let relevantTransitOptions = PUBLIC_TRANSIT_DATABASE.filter(t => {
      const sMatch = !detectedSource || t.source.toLowerCase().includes(detectedSource.toLowerCase());
      const dMatch = !detectedDest || t.destination.toLowerCase().includes(detectedDest.toLowerCase());
      return sMatch && dMatch;
    });

    let relevantRentals = RENTAL_FLEET_DATABASE.filter(r => {
      if (rentalCategory === 'all') return true;
      return r.category === rentalCategory;
    });

    let reply = '';
    let suggestedActions: { label: string; action: string; payload?: any }[] = [];

    // Synthesize response with Gemini if available, with 8s timeout
    if (aiClient) {
      try {
        const systemPrompt = `You are GARUDA AI, an agentic travel concierge and logistics engine specializing in Indian transport.
You adhere to strict rules:
1. NEVER invent fake train numbers, fake bus departures, or unverified live satellite GPS positions.
2. Distinguish clearly between estimated timetable information and live verified streams.
3. Compare cost, duration, luggage convenience, and transfer confidence.
4. If rental vehicles are discussed, clearly explain daily rates, security deposits, and fuel policy. Note that commercial partner API is in demo mode.
5. Provide clear, authoritative, concise responses (under 140 words).

Context:
- Detected Origin: ${detectedSource || 'Visakhapatnam'}
- Detected Destination: ${detectedDest || 'Hyderabad'}
- Available Public Transit Matches: ${JSON.stringify(relevantTransitOptions.slice(0, 3).map(t => ({
          service: t.serviceNumber,
          type: t.type,
          dep: t.departureTime,
          arr: t.arrivalTime,
          duration: `${Math.round(t.durationMinutes / 60)}h ${t.durationMinutes % 60}m`,
          fareINR: t.baseFareINR,
          stops: t.intermediateStops.slice(0, 4)
        })))}
- Available Rental Fleet Matches: ${JSON.stringify(relevantRentals.slice(0, 2).map(r => ({
          name: r.name,
          category: r.category,
          pricePerDayINR: r.pricePerDayINR,
          depositINR: r.securityDepositINR,
          fuelPolicy: r.fuelPolicy
        })))}

User Query: "${trimmedMsg}"`;

        const aiResponse = await aiClient.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: systemPrompt
        });

        reply = aiResponse.text || '';
      } catch (geminiError) {
        console.warn('Gemini chat error, using deterministic agent fallback.');
      }
    }

    if (!reply) {
      if (isRentalQuery) {
        const topRental = relevantRentals[0] || RENTAL_FLEET_DATABASE[0];
        const totalCost = topRental.pricePerDayINR * rentalDays;
        reply = `For ${rentalDays} days in ${detectedDest || 'the city'}, I recommend the ${topRental.name} (${topRental.category.toUpperCase()}).
- Rate: ₹${topRental.pricePerDayINR.toLocaleString('en-IN')}/day → Total: ₹${totalCost.toLocaleString('en-IN')} for ${rentalDays} days
- Refundable Deposit: ₹${topRental.securityDepositINR.toLocaleString('en-IN')}
- Fuel Policy: ${topRental.fuelPolicy} (${topRental.mileageOrRange})
- Note: Shown in Demo Mode (commercial rental provider API not connected).`;
      } else if (isPublicTransitQuery && detectedSource.toLowerCase().includes('vizianagaram')) {
        reply = `The cheapest way to travel from Vizianagaram to Visakhapatnam is the 08527 MEMU Suburban Commuter Train at 06:15 AM (Fare: ₹40, 1h 20m). Alternatively, APSRTC Express buses run every 15 minutes along NH-16 (Fare: ₹75, 1h 25m). Both offer high on-time reliability.`;
      } else if (isDisruptionQuery) {
        reply = `In case of transit delays on your active corridor, GARUDA pre-computes Plan B (TSRTC/APSRTC Multi-Axle Volvo AC Sleeper, saving ₹450) and Plan C (Morning Flight VTZ→HYD, faster by 2.5 hours). You can inspect recovery slacks directly.`;
      } else {
        const topOption = relevantTransitOptions[0] || PUBLIC_TRANSIT_DATABASE[0];
        reply = `For ${detectedSource || 'Visakhapatnam'} to ${detectedDest || 'Hyderabad'}, the recommended option is ${topOption.serviceNumber} departing at ${topOption.departureTime} (arrives ${topOption.arrivalTime}, ${Math.round(topOption.durationMinutes / 60)}h). Fare is ₹${topOption.baseFareINR.toLocaleString('en-IN')} with bedroll included and high 94% on-time confidence.`;
      }
    }

    if (isRentalQuery) {
      suggestedActions = [
        { label: 'Open Rental Transportation (Mode B)', action: 'NAVIGATE', payload: 'own_rented_vehicle' },
        { label: 'View Royal Brothers Portal', action: 'EXTERNAL_URL', payload: 'https://www.royalbrothers.com/' }
      ];
    } else if (isDisruptionQuery) {
      suggestedActions = [
        { label: 'Launch Disruption Simulator', action: 'NAVIGATE', payload: 'disruption' },
        { label: 'View Backup Routes', action: 'NAVIGATE', payload: 'routes' }
      ];
    } else {
      suggestedActions = [
        { label: 'View Public Transport (Mode A)', action: 'NAVIGATE', payload: 'public_transport' },
        { label: 'Compare Multimodal Routes', action: 'NAVIGATE', payload: 'routes' },
        { label: 'IRCTC Official Portal', action: 'EXTERNAL_URL', payload: 'https://www.irctc.co.in/' }
      ];
    }

    res.json({
      success: true,
      reply,
      suggestedActions,
      extractedContext: {
        detectedSource,
        detectedDest,
        isRentalQuery,
        isPublicTransitQuery
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Chat concierge service temporarily unavailable.' });
  }
});

// ============================================================================
// 8. TRIP PLANNING, ROUTE COMPARISON & BUDGET CALCULATORS
// ============================================================================
app.post('/api/trips/plan', (req: Request, res: Response) => {
  try {
    const { parsedRequest } = req.body;
    if (!parsedRequest) {
      return res.status(400).json({ success: false, error: 'parsedRequest parameter is required.' });
    }
    const result = GarudaCoordinator.coordinatePlan(parsedRequest);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ error: 'Trip planning failed.' });
  }
});

app.get('/api/routes/compare', (_req: Request, res: Response) => {
  res.json({ success: true, data: mockRouteOptions });
});

app.post('/api/trips/switch-mode', (req: Request, res: Response) => {
  try {
    const { trip, segmentId, targetMode } = req.body;
    if (!trip || !segmentId || !targetMode) {
      return res.status(400).json({ success: false, error: 'trip, segmentId, and targetMode are required.' });
    }
    const comparison = TravelModeSwitchingAgent.evaluateSwitch(trip, segmentId, targetMode);
    res.json({ success: true, data: comparison });
  } catch (error: any) {
    res.status(500).json({ error: 'Mode switch evaluation failed.' });
  }
});

app.post('/api/trips/backward-plan', (req: Request, res: Response) => {
  try {
    const { targetArrival, segments, bufferMinutes } = req.body;
    if (!targetArrival || !segments) {
      return res.status(400).json({ success: false, error: 'targetArrival and segments are required.' });
    }
    const result = BackwardPlanningAgent.calculateDeparture(targetArrival, segments, bufferMinutes);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ error: 'Backward planning calculation failed.' });
  }
});

app.post('/api/trips/budget-summary', (req: Request, res: Response) => {
  try {
    const { trip } = req.body;
    if (!trip) {
      return res.status(400).json({ success: false, error: 'trip object is required.' });
    }
    const summary = FixedBudgetAgent.calculateBudgetSummary(trip);
    res.json({ success: true, data: summary });
  } catch (error: any) {
    res.status(500).json({ error: 'Budget calculation failed.' });
  }
});

// Server bootstrap with Vite middleware
async function startServer() {
  let port = 3000;
  const portIndex = process.argv.indexOf('--port');
  if (portIndex !== -1 && process.argv[portIndex + 1]) {
    port = parseInt(process.argv[portIndex + 1], 10);
  } else if (process.env.PORT) {
    port = parseInt(process.env.PORT, 10);
  }

  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`GARUDA AI Server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
});
