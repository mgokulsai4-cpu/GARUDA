import { TripUnderstandingAgent } from './src/services/agents/tripUnderstandingAgent.js';
import { GarudaCoordinator } from './src/services/agents/coordinator.js';
import { DisruptionRecoveryAgent } from './src/services/agents/disruptionRecoveryAgent.js';
import { FixedBudgetAgent } from './src/services/agents/fixedBudgetAgent.js';

let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`✅ [PASS] ${testName}`);
    passedTests++;
  } else {
    console.error(`❌ [FAIL] ${testName}${detail ? ` - ${detail}` : ''}`);
    failedTests++;
  }
}

async function runTestSuite() {
  console.log('================================================================');
  console.log('GARUDA AI: Functional Correctness & Judge-Demo Verification Test');
  console.log('================================================================\n');

  // --------------------------------------------------------------------------
  // FUNCTION 1: Natural-language journey requests with dynamic inputs
  // --------------------------------------------------------------------------
  console.log('--- Testing Function 1: Natural-Language Parsing with Dynamic Inputs ---');
  const prompt1 = 'Plan a 3-day trip from Bengaluru to Goa starting 2026-11-15 with a budget of ₹25,000 for 3 travelers arriving before 09:30 AM with 3 bags';
  const parsed1 = TripUnderstandingAgent.parsePrompt(prompt1);

  assert(parsed1.origin === 'Bengaluru', 'Dynamic Origin extracted correctly', `Expected Bengaluru, got ${parsed1.origin}`);
  assert(parsed1.destination === 'Goa', 'Dynamic Destination extracted correctly', `Expected Goa, got ${parsed1.destination}`);
  assert(parsed1.durationDays === 3, 'Dynamic Duration extracted correctly', `Expected 3, got ${parsed1.durationDays}`);
  assert(parsed1.startDate === '2026-11-15', 'Dynamic Start Date extracted correctly', `Expected 2026-11-15, got ${parsed1.startDate}`);
  assert(parsed1.totalBudgetINR === 25000, 'Dynamic Budget extracted correctly', `Expected 25000, got ${parsed1.totalBudgetINR}`);
  assert(parsed1.numTravelers === 3, 'Dynamic Traveler count extracted correctly', `Expected 3, got ${parsed1.numTravelers}`);
  assert(parsed1.arrivalDeadline === '09:30 AM', 'Dynamic Arrival Deadline extracted correctly', `Expected 09:30 AM, got ${parsed1.arrivalDeadline}`);
  assert(parsed1.luggageCount === 3, 'Dynamic Luggage Count extracted correctly', `Expected 3, got ${parsed1.luggageCount}`);

  // Test input change variance
  const prompt2 = 'విశాఖపట్నం నుండి హైదరాబాద్ ప్రయాణించాలి, ఉదయం 9 గంటల లోపు చేరాలి, బడ్జెట్ ₹15,000 2 days for 2 people';
  const parsed2 = TripUnderstandingAgent.parsePrompt(prompt2);
  assert(parsed2.origin === 'Visakhapatnam' && parsed2.destination === 'Hyderabad', 'Telugu Origin & Destination extracted', `${parsed2.origin} -> ${parsed2.destination}`);
  assert(parsed2.totalBudgetINR === 15000, 'Changed Budget produces distinct output', `Expected 15000, got ${parsed2.totalBudgetINR}`);
  assert(parsed2.totalBudgetINR !== parsed1.totalBudgetINR, 'Changing inputs alters parsed state');

  // --------------------------------------------------------------------------
  // FUNCTION 2: Multi-leg itinerary generation & meaningful comparison
  // --------------------------------------------------------------------------
  console.log('\n--- Testing Function 2: Multi-Leg Itinerary Generation & Route Alternatives ---');
  const planResult = GarudaCoordinator.coordinatePlan(parsed1);
  const trip = planResult.trip;

  assert(trip.origin === 'Bengaluru' && trip.destination === 'Goa', 'Trip origin/destination reflects input');
  assert(Boolean(trip.candidateRoutes && trip.candidateRoutes.length === 3), 'Generated 3 distinct multimodal candidate routes');

  const [routeTrain, routeFlight, routeBus] = trip.candidateRoutes!;
  assert(routeTrain.primaryMode === 'train', 'Candidate 1 is Train+Metro/Feeder');
  assert(routeFlight.primaryMode === 'flight', 'Candidate 2 is Flight+Feeder');
  assert(routeBus.primaryMode === 'bus', 'Candidate 3 is AC Sleeper Bus');

  assert(routeTrain.segments.length >= 3, 'Train route has complete multi-leg door-to-door segments (Feeder -> Train -> Last Mile)');
  assert(routeTrain.segments[0].from.includes('Bengaluru'), 'Train first-leg departs from Bengaluru');
  assert(routeTrain.segments[1].to.includes('Goa'), 'Train line-haul arrives in Goa');

  assert(routeFlight.totalDurationMinutes < routeTrain.totalDurationMinutes, 'Flight option is faster than train', `${routeFlight.totalDurationMinutes}m vs ${routeTrain.totalDurationMinutes}m`);
  assert(routeBus.doorToDoorCostINR < routeTrain.doorToDoorCostINR, 'Bus option is cheaper than train', `₹${routeBus.doorToDoorCostINR} vs ₹${routeTrain.doorToDoorCostINR}`);

  // Destination accommodation & itinerary
  assert(trip.selectedHotel.city.toLowerCase() === 'goa', 'Selected hotel is located in target city (Goa)', trip.selectedHotel.name);
  assert(trip.itinerary.length === 3, 'Itinerary has 3 days matching duration');
  assert(trip.itinerary[0].date === '2026-11-15', 'Itinerary Day 1 date matches departure date', trip.itinerary[0].date);
  assert(trip.itinerary[1].date === '2026-11-16', 'Itinerary Day 2 date aligns', trip.itinerary[1].date);
  assert(trip.itinerary[2].date === '2026-11-17', 'Itinerary Day 3 date aligns', trip.itinerary[2].date);

  const budgetSummary = FixedBudgetAgent.calculateBudgetSummary(trip);
  assert(budgetSummary.projectedTotalCost <= parsed1.totalBudgetINR, 'Initial plan satisfies hard budget ceiling', `₹${budgetSummary.projectedTotalCost} <= ₹${parsed1.totalBudgetINR}`);

  // --------------------------------------------------------------------------
  // FUNCTION 3: Reproducible disruption simulation
  // --------------------------------------------------------------------------
  console.log('\n--- Testing Function 3: Reproducible Disruption Simulation ---');
  const delayMinutes = 150;
  const disruption = DisruptionRecoveryAgent.generateRecoveryScenarios(trip, 'train_delayed', delayMinutes);

  assert(disruption.type === 'train_delayed', 'Disruption type is train_delayed');
  assert(disruption.delayMinutes === 150, 'Delay duration matches simulated slider (150m)');
  assert(disruption.affectedSegmentTitle.includes('Bengaluru') || disruption.affectedSegmentTitle.includes('Goa') || disruption.affectedSegmentTitle.includes('Train'), 'Disruption specifies affected route on active corridor');
  assert(!!disruption.planB && !!disruption.planC, 'Disruption automatically pre-computes Plan B and Plan C');

  // --------------------------------------------------------------------------
  // FUNCTION 4: Automatic replanning with valid alternatives & explanations
  // --------------------------------------------------------------------------
  console.log('\n--- Testing Function 4: Automatic Replanning & Alternative Explanation ---');
  const planB = disruption.planB;
  const planC = disruption.planC;

  assert(planB.primaryMode === 'bus', 'Plan B switches to AC Sleeper Bus');
  assert(planB.costDifferenceINR < 0, 'Plan B saves budget', `Cost delta: ₹${planB.costDifferenceINR}`);
  assert(planB.segments.length >= 3, 'Plan B provides valid multi-leg journey segments');
  assert(planB.keyTradeoff.length > 10, 'Plan B provides clear trade-off explanation', planB.keyTradeoff);

  assert(planC.primaryMode === 'flight', 'Plan C switches to Direct Flight');
  assert(planC.timeDifferenceMinutes < 0, 'Plan C provides faster arrival', `Time delta: ${planC.timeDifferenceMinutes}m`);
  assert(planC.keyTradeoff.length > 10, 'Plan C explains cost/convenience tradeoff', planC.keyTradeoff);

  // --------------------------------------------------------------------------
  // FUNCTION 5: Explicit user approval before accepting proposed revised itinerary
  // --------------------------------------------------------------------------
  console.log('\n--- Testing Function 5: Explicit User Approval & Itinerary Revision ---');
  // Prior to approval:
  assert(trip.planVersion === 1, 'Trip is initially at Plan v1');

  // User explicitly approves Plan B:
  const revisedTrip = DisruptionRecoveryAgent.acceptRecoveryPlan(trip, disruption, planB);

  assert(revisedTrip.planVersion === 2, 'Approved plan advances to Plan v2', `v${revisedTrip.planVersion}`);
  assert(revisedTrip.versionHistory.length === 2, 'Version history contains audit log of approved change');
  assert(revisedTrip.versionHistory[0].reason.includes('Plan B'), 'Version audit log cites approved Plan B');
  assert(revisedTrip.activeDisruption === undefined, 'Active disruption cleared upon approval');
  assert(revisedTrip.selectedRoute.primaryMode === 'bus', 'Active transit mode switched to Bus as approved');
  assert(revisedTrip.itinerary[0].activities[0].title.includes('Bus') || revisedTrip.itinerary[0].activities[0].title.includes('Plan B'), 'Itinerary Day 1 visibly updated to reflect revised transit arrival');

  const revisedBudget = FixedBudgetAgent.calculateBudgetSummary(revisedTrip);
  assert(revisedBudget.projectedTotalCost <= trip.totalBudgetINR, 'Revised itinerary strictly satisfies budget constraint', `₹${revisedBudget.projectedTotalCost} <= ₹${trip.totalBudgetINR}`);

  // Summary
  console.log('\n================================================================');
  console.log(`TEST RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
