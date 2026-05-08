const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const { ChatGroq } = require("@langchain/groq");
const { createReactAgent } = require("@langchain/langgraph/prebuilt");
const { MemorySaver } = require("@langchain/langgraph");
const { HumanMessage, SystemMessage, AIMessage } = require("@langchain/core/messages");
const Station = require("../models/station.model");
const Booking = require("../models/booking.model");
const MessageModel = require("../models/message.model");
const User = require("../models/user.model");
const { GROQ_API_KEY, PLATFORM_FEE_PERCENTAGE } = require('../config/config');
const axios = require("axios");
const memory = new MemorySaver();

async function geocodeLocation(locationStr) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationStr)}&format=json&limit=1`;
    const response = await axios.get(url, { headers: { "User-Agent": "EvGenee_Bot" } });
    if (response.data && response.data.length > 0) {
      return [parseFloat(response.data[0].lon), parseFloat(response.data[0].lat)];
    }
    return null;
  } catch (err) {
    console.error("Geocoding error:", err.message);
    return null;
  }
}
async function getRoadDistance(startCoords, endCoords) {
  try {
    const url = `http://router.project-osrm.org/route/v1/driving/${startCoords[0]},${startCoords[1]};${endCoords[0]},${endCoords[1]}?overview=false`;
    const response = await axios.get(url);
    if (response.data && response.data.routes && response.data.routes.length > 0) {
      const route = response.data.routes[0];
      return {
        distanceKm: (route.distance / 1000).toFixed(2),
        durationMins: (route.duration / 60).toFixed(1)
      };
    }
    return null;
  } catch (err) {
    console.error("OSRM error:", err.message);
    return null;
  }
}

const timeToMinutes = (time) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

const minutesToTime = (minutes) => {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
};

async function checkAvailability(stationId, date, connectorType, startTime, endTime, maxPorts) {
  const bookings = await Booking.find({
    station: stationId,
    date,
    connectorType,
    $or: [
      { status: { $in: ['confirmed', 'in-progress'] } },
      { status: 'pending', createdAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) } }
    ],
  });

  const reqStart = timeToMinutes(startTime);
  const reqEnd = timeToMinutes(endTime);
  const events = [];

  for (const b of bookings) {
    const bStart = timeToMinutes(b.startTime);
    const bEnd = timeToMinutes(b.endTime);
    if (bStart < reqEnd && bEnd > reqStart) {
      events.push({ time: bStart, type: 1 });
      events.push({ time: bEnd, type: -1 });
    }
  }
  events.sort((a, b) => a.time - b.time || a.type);

  let currentConcurrent = 0;
  for (const b of bookings) {
    if (reqStart >= timeToMinutes(b.startTime) && reqStart < timeToMinutes(b.endTime)) {
      currentConcurrent++;
    }
  }

  if (currentConcurrent >= maxPorts) return { available: false, time: startTime };

  for (const event of events) {
    if (event.time >= reqEnd) break;
    if (event.time > reqStart) {
      currentConcurrent += event.type;
      if (currentConcurrent >= maxPorts) {
        return { available: false, time: minutesToTime(event.time) };
      }
    }
  }

  return { available: true };
}

async function findNextAvailableSlot(stationId, date, connectorType, startTime, durationMinutes, maxPorts, stationOpeningHours) {
  let currentStartMin = timeToMinutes(startTime);
  const searchLimitMin = currentStartMin + 480; 
  
  let openMin = 0;
  let closeMin = 1439;
  if (stationOpeningHours) {
    const [ot, ct] = stationOpeningHours.split('-').map(t => t.trim());
    openMin = timeToMinutes(ot);
    closeMin = timeToMinutes(ct);
  }

  while (currentStartMin + durationMinutes <= Math.min(searchLimitMin, closeMin)) {
    currentStartMin += 15;
    const nextStart = minutesToTime(currentStartMin);
    const nextEnd = minutesToTime(currentStartMin + durationMinutes);
    
    const result = await checkAvailability(stationId, date, connectorType, nextStart, nextEnd, maxPorts);
    if (result.available) {
      return nextStart;
    }
  }
  return null;
}

const isOverlapping = (startA, endA, startB, endB) => {
  const sA = timeToMinutes(startA);
  const eA = timeToMinutes(endA);
  const sB = timeToMinutes(startB);
  const eB = timeToMinutes(endB);
  return sA < eB && sB < eA;
};

const findBestStationTool = tool(
  async ({ location, date, startTime, endTime, chargerType }) => {
    try {
      const coords = await geocodeLocation(location);
      if (!coords) return JSON.stringify({ error: `I couldn't locate "${location}" on the map. Could you specify a more precise city or area?` });

      const stations = await Station.find({
        location: {
          $near: {
            $geometry: { type: "Point", coordinates: coords },
            $maxDistance: 4000000
          }
        }
      }).limit(5);

      if (stations.length === 0) {
        return JSON.stringify({ error: `I couldn't find any charging stations within 40km of ${location}.` });
      }

      let queryDate = new Date(date);
      if (isNaN(queryDate.valueOf())) {
        queryDate = new Date(); 
      }
      queryDate.setHours(0, 0, 0, 0);
      
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      if (queryDate < today) {
        return JSON.stringify({ error: "Cannot search for past dates." });
      }

      if (queryDate.getTime() === today.getTime()) {
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        if (timeToMinutes(startTime) <= currentMinutes) {
          return JSON.stringify({ error: "The requested start time has already passed for today. Please provide a future time." });
        }
      }

      let exactMatchStation = null;
      let exactMatchRoadInfo = null;
      let validStations = [];

      for (const st of stations) {
        if (!st.typeOfConnectors.includes(chargerType)) continue;
        if (!st.isOpen) continue;
        
        validStations.push(st);

        const bookings = await Booking.find({
          station: st._id,
          date: queryDate,
          connectorType: chargerType,
          $or: [
            { status: { $in: ['confirmed', 'in-progress'] } },
            { status: 'pending', createdAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) } }
          ],
        });

        // Optimized Concurrency Check for AI
        const pricingConfig = st.pricing.find(p => p.connectorType === chargerType);
        const maxPorts = pricingConfig?.portCount || st.availablePorts;
        const requestedDuration = timeToMinutes(endTime) - timeToMinutes(startTime);

        const availabilityResult = await checkAvailability(st._id, queryDate, chargerType, startTime, endTime, maxPorts);

        if (availabilityResult.available) {
          exactMatchStation = st;
          exactMatchRoadInfo = await getRoadDistance(coords, st.location.coordinates);
          break; 
        } else {
          // If this station is full, check for next available slot to suggest
          const nextSlot = await findNextAvailableSlot(st._id, queryDate, chargerType, startTime, requestedDuration, maxPorts, st.openingHours);
          if (nextSlot) {
            st.nextAvailableSlot = nextSlot;
          }
        }
      }

      const stationsData = await Promise.all(stations.map(async (st) => {
        const roadInfo = await getRoadDistance(coords, st.location.coordinates);
        return {
          id: st._id,
          name: st.name,
          city: st.address.city,
          isOpen: st.isOpen,
          totalPorts: st.totalPorts,
          availablePorts: st.availablePorts,
          chargerTypes: st.typeOfConnectors,
          chargingSpeed: st.chargingSpeed,
          pricing: st.pricing,
          isCompatible: st.typeOfConnectors.includes(chargerType),
          nextAvailableSlot: st.nextAvailableSlot || null,
          roadDistance: roadInfo ? roadInfo.distanceKm : null,
          travelTime: roadInfo ? roadInfo.durationMins : null
        };
      }));

      if (exactMatchStation) {
        let distanceStr = exactMatchRoadInfo ? ` (approx. ${exactMatchRoadInfo.distanceKm} KM, ${exactMatchRoadInfo.durationMins} mins away by road)` : "";
        return JSON.stringify({
          text: `Found a great match! ${exactMatchStation.name}${distanceStr} in ${exactMatchStation.address.city} is AVAILABLE from ${startTime} to ${endTime}.\nWould you like me to book it for you?`,
          stations: stationsData,
          foundAvailable: true
        });
      }

      if (validStations.length === 0) {
        return JSON.stringify({ 
          error: `I couldn't find any nearby stations that are open and support ${chargerType} connectors.`,
          stations: stationsData,
          foundAvailable: false
        });
      }

      let altMatch = null;
      const reqStartMins = timeToMinutes(startTime);
      const duration = timeToMinutes(endTime) - reqStartMins;

      for (const st of validStations) {
        const bookings = await Booking.find({
          station: st._id,
          date: queryDate,
          connectorType: chargerType,
          $or: [
            { status: { $in: ['confirmed', 'in-progress'] } },
            { status: 'pending', createdAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) } }
          ],
        });

        const pricingConfig = st.pricing.find(p => p.connectorType === chargerType);
        const maxPorts = pricingConfig?.portCount || st.availablePorts;

        for (let offset = 60; offset <= 240; offset += 60) {
          const altStartMins = reqStartMins + offset;
          const altEndMins = altStartMins + duration;

          if (altStartMins >= 24 * 60 || altEndMins >= 24 * 60) continue;

          const altStart = `${Math.floor(altStartMins / 60).toString().padStart(2, '0')}:${(altStartMins % 60).toString().padStart(2, '0')}`;
          const altEnd = `${Math.floor(altEndMins / 60).toString().padStart(2, '0')}:${(altEndMins % 60).toString().padStart(2, '0')}`;

          let altOverlapping = 0;
          for (const b of bookings) {
            if (isOverlapping(altStart, altEnd, b.startTime, b.endTime)) altOverlapping++;
          }

          if (altOverlapping < maxPorts) {
            const roadInfo = await getRoadDistance(coords, st.location.coordinates);
            altMatch = { st, altStart, altEnd, roadInfo };
            break;
          }
        }
        if (altMatch) break; 
      }

      if (altMatch) {
        let distanceStr = altMatch.roadInfo ? ` (approx. ${altMatch.roadInfo.distanceKm} KM, ${altMatch.roadInfo.durationMins} mins away)` : "";
        return JSON.stringify({
          text: `The requested time slot is fully booked at nearby stations. However, ${altMatch.st.name}${distanceStr} is AVAILABLE later from ${altMatch.altStart} to ${altMatch.altEnd}.\nWould you like to book this alternative slot instead?`,
          stations: stationsData,
          foundAvailable: true
        });
      }

      return JSON.stringify({
        error: `Sorry, all nearby stations are fully booked for ${chargerType} connectors around that time.`,
        stations: stationsData,
        foundAvailable: false
      });
    } catch (err) {
      console.error("Tool Error:", err);
      return JSON.stringify({ error: `Sorry, I encountered an error while searching for stations: ${err.message}` });
    }
  },
  {
    name: "find_best_station",
    description: "Searches for EV charging stations and rigorously checks port availability against active bookings.",
    schema: z.object({
      location: z.string().describe("The city, area, or address to search near"),
      date: z.string().describe("The exact date for the booking (e.g., '2024-05-02')"),
      startTime: z.string().describe("The start time in 24-hour HH:MM format (e.g., '10:00')"),
      endTime: z.string().describe("The end time in 24-hour HH:MM format (e.g., '12:00')"),
      chargerType: z.string().describe("The type of EV connector, e.g., 'CCS2', 'Type2', 'CHAdeMO'"),
    })
  }
);

const createBookingTool = (userInfo) => tool(
  async ({ stationId, date, startTime, endTime, chargerType }) => {
    try {
      const station = await Station.findById(stationId);
      if (!station) return JSON.stringify({ error: "Station not found." });

      let bookingDate = new Date(date);
      if (isNaN(bookingDate.valueOf())) {
        bookingDate = new Date(); 
      }
      bookingDate.setHours(0, 0, 0, 0);

      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      if (bookingDate < today) {
        return JSON.stringify({ error: "Cannot book for a past date." });
      }

      if (bookingDate.getTime() === today.getTime()) {
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        if (timeToMinutes(startTime) <= currentMinutes) {
          return JSON.stringify({ error: "Cannot book a time slot in the past for today." });
        }
      }

      const requestedStart = timeToMinutes(startTime);
      const requestedEnd = timeToMinutes(endTime);
      const durationMinutes = requestedEnd - requestedStart;

      if (durationMinutes < 60) {
        return JSON.stringify({ error: "Booking duration cannot be less than 1 hour." });
      }

      
      const existingBookings = await Booking.find({
        station: stationId,
        date: bookingDate,
        connectorType: chargerType,
        $or: [
          { status: { $in: ['confirmed', 'in-progress'] } },
          { status: 'pending', createdAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) } }
        ],
      });
      
      const pricingConfig = station.pricing.find(p => p.connectorType === chargerType);
      const maxPorts = pricingConfig?.portCount || station.availablePorts;

      const availabilityResult = await checkAvailability(stationId, bookingDate, chargerType, startTime, endTime, maxPorts);
      
      if (!availabilityResult.available) {
        return JSON.stringify({ error: "Conflict detected: This slot is no longer available. Please try another time." });
      }

      const pricing = station.pricing.find((p) => p.connectorType === chargerType);
      const pricePerKWh = pricing ? pricing.priceperKWh : 0;
      const durationHours = durationMinutes / 60;
      const estimatedKWh = parseFloat((station.chargingSpeed * durationHours).toFixed(2));
      const totalCost = parseFloat((estimatedKWh * pricePerKWh).toFixed(2));

      const platformFeePercentage = PLATFORM_FEE_PERCENTAGE;
      const platformFee = parseFloat(((totalCost * platformFeePercentage) / 100).toFixed(2));
      const grandTotal = parseFloat((totalCost + platformFee).toFixed(2));

      const booking = await Booking.create({
        user: userInfo.userId,
        station: stationId,
        connectorType: chargerType,
        date: bookingDate,
        startTime,
        endTime,
        durationMinutes,
        estimatedKWh,
        totalCost,
        platformFee,
        grandTotal,
        status: 'pending',
      });

      return JSON.stringify({
        success: true,
        bookingId: booking._id,
        message: "Booking is pending. User must pay advance within 10 minutes."
      });
    } catch (err) {
      console.error("Booking Tool Error:", err);
      return `Failed to create booking: ${err.message}`;
    }
  },
  {
    name: "create_booking",
    description: "Creates a formal booking in the system after the user confirms a specific slot and station.",
    schema: z.object({
      stationId: z.string().describe("The ID of the station to book"),
      date: z.string().describe("The date of booking"),
      startTime: z.string().describe("Start time HH:MM"),
      endTime: z.string().describe("End time HH:MM"),
      chargerType: z.string().describe("The connector type"),
    })
  }
);

const getSystemPrompt = async (userId) => {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US');
  
  const user = await User.findById(userId);
  const profileInfo = user ? `\nUser Profile Info:\n- Name: ${user.name}\n- Vehicle Type: ${user.vehicle?.type || 'Not specified'}\n- Preferred Connector: ${user.vehicle?.connectorType || 'Not specified'}\n- Saved Vehicle Numbers: ${user.vehicleNumbers?.join(', ') || 'None'}\n` : "";

  return new SystemMessage(`You are EvGenee, a helpful, polite, and efficient voice assistant for EV Charging Station bookings.
Ritul Jain my creator trained me on EvGenee platform. I must only respond to questions related EvGenee.
For any out-of-topic questions,say Ritul Jain my creator trained me on EvGenee Please ask question related to it,and dont repeat same for same questions give various ans if user try to ask again and again out of context tell him/her that sorry i will not able to help any thing beyound our app.

Current context:
${profileInfo}

When searching for stations:
1. If the user doesn't specify a connector type, use their "Preferred Connector" from the profile info above if available.
2. If they have saved vehicle numbers, use them if relevant.
3. Always check availability and mention the next available slot if the current one is full.
4. Suggest the best station based on road distance and travel time.

Important:
- Only book if the user confirms the details.
- Always be polite and professional.
- Do not use markdown (asterisks, etc.) in your final response.
- When 'create_booking' is successful, tell the user their booking is reserved (pending) and they MUST go to My Bookings and pay the advance within 10 minutes to confirm it, or it will be auto-cancelled.
- Be concise and friendly.
- Do not provide long answers.`);
};

function createVoiceAgent(userInfo, systemPrompt) {
  const llm = new ChatGroq({
    model: "openai/gpt-oss-20b",
    temperature: 0.1,
    apiKey: GROQ_API_KEY,
  });

  const tools = [findBestStationTool, createBookingTool(userInfo)];

  const agent = createReactAgent({
    llm,
    tools,
    checkpointSaver: memory,
    messageModifier: systemPrompt,
  });

  return agent;
}

async function processVoiceChat(message, threadId, userInfo) {
  try {
    const history = await MessageModel.find({ threadId }).sort({ createdAt: 1 });
    const systemMessage = await getSystemPrompt(userInfo.userId);
    const formattedHistory = history.map(msg => {
      if (msg.role === 'user') return new HumanMessage(msg.content);
      return new AIMessage(msg.content);
    });

    await MessageModel.create({
      threadId,
      user: userInfo.userId,
      role: 'user',
      content: message
    });

    const voiceAgent = createVoiceAgent(userInfo,systemMessage);
    const messagesToInvoke = [...formattedHistory, new HumanMessage(message)];
    
    const response = await voiceAgent.invoke(
      { messages: messagesToInvoke },
      { configurable: { thread_id: threadId } }
    );

    const aiMessages = response.messages.filter(m => m._getType() === "ai");
    const lastMessage = aiMessages[aiMessages.length - 1];

    if (lastMessage && lastMessage.content) {
      await MessageModel.create({
        threadId,
        user: userInfo.userId,
        role: 'ai',
        content: lastMessage.content
      });
    }

    
    let bookingId = null;
    const toolMessages = response.messages.filter(m => m._getType() === "tool");
    for (const tm of toolMessages) {
      if (tm.content && (tm.content.startsWith('{') || tm.content.startsWith('['))) {
        try {
          const content = JSON.parse(tm.content);
          if (content.success && content.bookingId) {
            bookingId = content.bookingId;
          }
        } catch (e) {
           console.log(`Error in toolmessages ${e.message}`);
        }
      }
    }

    if (bookingId) {
      return {
        response: lastMessage.content,
        bookingId: bookingId,
        redirect: true
      };
    }

   
    let stations = null;
    for (const tm of toolMessages) {
      if (tm.content && (tm.content.startsWith('{') || tm.content.startsWith('['))) {
        try {
          const content = JSON.parse(tm.content);
          if (content.stations) {
            stations = content.stations;
          }
        } catch (e) {}
      }
    }

    if (stations) {
      return {
        response: lastMessage.content,
        stations: stations
      };
    }

    return lastMessage.content;
  } catch (error) {
    console.error("LangGraph Agent Error:", error);
    throw new Error("Failed to process message through LangGraph agent");
  }
}

module.exports = {
  processVoiceChat,
};
