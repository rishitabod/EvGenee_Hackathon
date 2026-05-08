const Booking = require('../models/booking.model');
const Station = require('../models/station.model');
const { NODEMAILER_USER, NODEMAILER_PASS, NODEMAILER_PORT, PLATFORM_FEE_PERCENTAGE } = require('../config/config');  
const nodemailer = require("nodemailer");

const timeToMinutes = (time) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

const minutesToTime = (minutes) => {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
};

async function checkPortAvailability(stationId, date, connectorType, startTime, endTime, maxPorts) {
  const bookingDate = new Date(date);
  bookingDate.setHours(0, 0, 0, 0);

  const existingBookings = await Booking.find({
    station: stationId,
    date: bookingDate,
    connectorType,
    $or: [
      { status: { $in: ['confirmed', 'in-progress'] } },
      { status: 'pending', createdAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) } }
    ],
  });

  const reqStart = timeToMinutes(startTime);
  const reqEnd = timeToMinutes(endTime);
  const events = [];

  for (const b of existingBookings) {
    const bStart = timeToMinutes(b.startTime);
    const bEnd = timeToMinutes(b.endTime);
    if (bStart < reqEnd && bEnd > reqStart) {
      events.push({ time: bStart, type: 1 });
      events.push({ time: bEnd, type: -1 });
    }
  }
  events.sort((a, b) => a.time - b.time || a.type);

  let currentConcurrent = 0;
  for (const b of existingBookings) {
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
  const searchLimitMin = currentStartMin + 480; // Search up to 8 hours ahead
  
  let openMin = 0;
  let closeMin = 1439;
  if (stationOpeningHours) {
    const [ot, ct] = stationOpeningHours.split('-').map(t => t.trim());
    openMin = timeToMinutes(ot);
    closeMin = timeToMinutes(ct);
  }

  // Move in 15-minute increments
  while (currentStartMin + durationMinutes <= Math.min(searchLimitMin, closeMin)) {
    currentStartMin += 15;
    const nextStart = minutesToTime(currentStartMin);
    const nextEnd = minutesToTime(currentStartMin + durationMinutes);
    
    const result = await checkPortAvailability(stationId, date, connectorType, nextStart, nextEnd, maxPorts);
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


const generateOtp = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};
const createBooking = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { station: stationId, connectorType, date, startTime, endTime, vehicleNumber } = req.body;
     const {email:to}=req.user;
     console.log(req.user);

    const station = await Station.findById(stationId);
    if (!station) {
      return res.status(404).json({ success: false, message: 'Station not found' });
    }
    if (!station.isOpen) {
      return res.status(400).json({ success: false, message: 'Station is currently closed' });
    }
    if (station.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Station is inactive' });
    }


    if (!station.typeOfConnectors.includes(connectorType)) {
      return res.status(400).json({
        success: false,
        message: `This station does not support ${connectorType} connector. Available: ${station.typeOfConnectors.join(', ')}`,
      });
    }


    if (station.openingHours) {
      const [openTime, closeTime] = station.openingHours.split('-').map((t) => t.trim());
      const openMin = timeToMinutes(openTime);
      const closeMin = timeToMinutes(closeTime);
      const bookStartMin = timeToMinutes(startTime);
      const bookEndMin = timeToMinutes(endTime);

      if (bookStartMin < openMin || bookEndMin > closeMin) {
        return res.status(400).json({
          success: false,
          message: `Booking must be within station hours: ${station.openingHours}`,
        });
      }
    }


    const bookingDate = new Date(date);
    bookingDate.setHours(0, 0, 0, 0);

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (bookingDate < today) {
      return res.status(400).json({ success: false, message: 'Cannot book for a past date' });
    }

    if (bookingDate.getTime() === today.getTime()) {
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      if (timeToMinutes(startTime) <= currentMinutes) {
        return res.status(400).json({ success: false, message: 'Cannot book a time slot in the past for today' });
      }
    }

    const [existingBookings, userConflict] = await Promise.all([
      Booking.find({
        station: stationId,
        date: bookingDate,
        connectorType,
        $or: [
          { status: { $in: ['confirmed', 'in-progress'] } },
          { status: 'pending', createdAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) } }
        ],
      }),
      Booking.findOne({
        user: userId,
        date: bookingDate,
        $and: [
          {
            $or: [
              { status: { $in: ['confirmed', 'in-progress'] } },
              { status: 'pending', createdAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) } }
            ]
          },
          {
            $or: [
              {
                $and: [
                  { startTime: { $lt: endTime } },
                  { endTime: { $gt: startTime } },
                ],
              },
            ],
          }
        ]
      })
    ]);

    const requestedStart = timeToMinutes(startTime);
    const requestedEnd = timeToMinutes(endTime);
    
    const pricingConfig = station.pricing.find(p => p.connectorType === connectorType);
    const maxPorts = pricingConfig?.portCount || station.availablePorts;

    // Optimized Concurrency Check using Sweep Line Algorithm
    const events = [];
    for (const booking of existingBookings) {
      const bStart = timeToMinutes(booking.startTime);
      const bEnd = timeToMinutes(booking.endTime);
      
      // Only consider bookings that overlap with our requested window
      if (bStart < requestedEnd && bEnd > requestedStart) {
        events.push({ time: bStart, type: 1 });
        events.push({ time: bEnd, type: -1 });
      }
    }

    // Sort events by time, then by type (end events first if times are equal)
    events.sort((a, b) => a.time - b.time || a.type);

    let currentConcurrent = 0;
    // Check initial concurrency at requestedStart
    for (const booking of existingBookings) {
      const bStart = timeToMinutes(booking.startTime);
      const bEnd = timeToMinutes(booking.endTime);
      if (requestedStart >= bStart && requestedStart < bEnd) {
        currentConcurrent++;
      }
    }

    if (currentConcurrent >= maxPorts) {
      const nextSlot = await findNextAvailableSlot(stationId, bookingDate, connectorType, startTime, requestedEnd - requestedStart, maxPorts, station.openingHours);
      return res.status(409).json({
        success: false,
        message: `No available ${connectorType} ports at ${startTime}. All ${maxPorts} ports are booked.`,
        nextAvailableSlot: nextSlot,
        suggestion: nextSlot ? `Try booking at ${nextSlot} instead.` : 'Try a different date or station.',
      });
    }

    for (const event of events) {
      if (event.time >= requestedEnd) break;
      if (event.time > requestedStart) {
        currentConcurrent += event.type;
        if (currentConcurrent >= maxPorts) {
          const conflictTime = minutesToTime(event.time);
          const nextSlot = await findNextAvailableSlot(stationId, bookingDate, connectorType, startTime, requestedEnd - requestedStart, maxPorts, station.openingHours);
          return res.status(409).json({
            success: false,
            message: `No available ${connectorType} ports at ${conflictTime}. All ${maxPorts} ports are booked.`,
            nextAvailableSlot: nextSlot,
            suggestion: nextSlot ? `Try booking at ${nextSlot} instead.` : 'Try a different date or station.',
          });
        }
      }
    }
    if (userConflict) {
      return res.status(409).json({
        success: false,
        message: 'You already have an overlapping booking at this time',
        existingBooking: {
          startTime: userConflict.startTime,
          endTime: userConflict.endTime,
        },
      });
    }


    const durationMinutes = requestedEnd - requestedStart;
    const pricing = station.pricing.find((p) => p.connectorType === connectorType);
    const basePricePerKWh = pricing ? pricing.priceperKWh : 0;
    let finalPricePerKWh = basePricePerKWh;
    let appliedMultiplier = 1.0;

    if (station.peakPricing && station.peakPricing.length > 0) {
      for (const peak of station.peakPricing) {
        const peakStart = timeToMinutes(peak.startTime);
        const peakEnd = timeToMinutes(peak.endTime);
        if (requestedStart < peakEnd && requestedEnd > peakStart) {
          if (peak.multiplier > appliedMultiplier) {
            appliedMultiplier = peak.multiplier;
            finalPricePerKWh = basePricePerKWh * peak.multiplier;
          }
        }
      }
    }

    const durationHours = durationMinutes / 60;
    const estimatedKWh = parseFloat((station.chargingSpeed * durationHours).toFixed(2));
    const totalCost = parseFloat((estimatedKWh * finalPricePerKWh).toFixed(2));
    
    const platformFeePercentage = PLATFORM_FEE_PERCENTAGE;
    const platformFee = parseFloat(((totalCost * platformFeePercentage) / 100).toFixed(2));
    const grandTotal = parseFloat((totalCost + platformFee).toFixed(2));


    const otp = generateOtp();
    const otpExpiresAt = new Date(bookingDate);
    const [endH, endM] = endTime.split(':').map(Number);
    otpExpiresAt.setHours(endH, endM, 0, 0);
    const transporter=nodemailer.createTransport({
      secure:true,
      host:"smtp.gmail.com",
      port: Number(NODEMAILER_PORT),
      auth:{
        user:NODEMAILER_USER,
        pass:NODEMAILER_PASS
      }
    })
    await transporter.sendMail({
      to: to,
      subject: "EvGenee - Your Booking is Confirmed! \u26A1",
      html: `
      <div style="font-family: 'Inter', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 30px; border-radius: 12px; border: 1px solid #eaeaea; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
        <div style="text-align: center; margin-bottom: 25px;">
          <h1 style="color: #10B981; margin: 0; font-size: 28px;">EvGenee</h1>
          <p style="color: #6b7280; margin-top: 5px; font-size: 14px;">Your intelligent EV charging partner</p>
        </div>
        
        <h2 style="color: #111827; font-size: 20px; margin-bottom: 20px;">Booking Confirmed! 🎉</h2>
        <p style="color: #374151; font-size: 16px; line-height: 1.5;">Hi <strong>${req.user.name}</strong>,</p>
        <p style="color: #374151; font-size: 16px; line-height: 1.5;">Your EV charging slot has been successfully reserved. Here are the details of your upcoming session:</p>
        
        <div style="background-color: #f9fafb; padding: 20px; border-radius: 8px; border: 1px solid #f3f4f6; margin: 25px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 40%;"><strong>Station</strong></td>
              <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 500;">${station.name}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-top: 1px solid #f3f4f6;"><strong>Location</strong></td>
              <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 500; border-top: 1px solid #f3f4f6;">${station.address.city}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-top: 1px solid #f3f4f6;"><strong>Date</strong></td>
              <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 500; border-top: 1px solid #f3f4f6;">${bookingDate.toISOString().split('T')[0]}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-top: 1px solid #f3f4f6;"><strong>Time Slot</strong></td>
              <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 500; border-top: 1px solid #f3f4f6;">${startTime} to ${endTime}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-top: 1px solid #f3f4f6;"><strong>Connector</strong></td>
              <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 500; border-top: 1px solid #f3f4f6;">${connectorType}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-top: 1px solid #f3f4f6;"><strong>Est. Total</strong></td>
              <td style="padding: 8px 0; color: #10B981; font-size: 16px; font-weight: bold; border-top: 1px solid #f3f4f6;">₹${grandTotal}</td>
            </tr>
          </table>
        </div>

        <p style="color: #374151; font-size: 16px; text-align: center; margin-top: 30px;">Your secure check-in OTP:</p>
        <div style="text-align: center; margin: 15px 0 30px 0;">
          <div style="display: inline-block; font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #059669; background-color: #ecfdf5; padding: 15px 30px; border-radius: 10px; border: 2px dashed #10B981;">
            ${otp}
          </div>
          <p style="color: #9ca3af; font-size: 12px; margin-top: 8px;">Please show this OTP at the station to begin charging.</p>
        </div>
        
        <hr style="border: none; border-top: 1px solid #eaeaea; margin: 30px 0;" />
        <p style="color: #9ca3af; font-size: 13px; text-align: center; margin: 0;">
          Thank you for choosing EvGenee!<br/>Drive safe, stay charged. ⚡
        </p>
      </div>`
    });
    
    const booking = await Booking.create({
      user: userId,
      station: stationId,
      connectorType,
      date: bookingDate,
      startTime,
      endTime,
      durationMinutes,
      estimatedKWh,
      totalCost,
      platformFee,
      grandTotal,
      vehicleNumber: vehicleNumber || '',
      status: 'confirmed',
      otp,
      otpExpiresAt,
    });


    const io = req.app.get('io');
    if (io) {
      io.to(`station_${stationId}`).emit('booking:created', {
        stationId,
        bookingId: booking._id,
        connectorType,
        startTime,
        endTime,
        date: bookingDate,
      });

      io.to(`user_${userId}`).emit('booking:created', {
        bookingId: booking._id,
        stationId,
        status: 'confirmed',
      });


      const updatedBookings = await Booking.countDocuments({
        station: stationId,
        date: bookingDate,
        status: { $in: ['confirmed', 'in-progress'] },
      });
      io.to(`station_${stationId}`).emit('availability:updated', {
        stationId,
        date: bookingDate,
        activeBookings: updatedBookings,
        totalPorts: station.totalPorts,
      });
    }

    // Emit WebSocket event for capacity change
    const io_cap = req.app.get('io');
    if (io_cap) {
      io_cap.emit('station:capacity_changed', {
        stationId: booking.station,
        connectorType: booking.connectorType,
        status: booking.status,
        timestamp: new Date()
      });
    }

    res.status(201).json({
      success: true,
      message: 'Booking confirmed successfully',
      data: {
        bookingId: booking._id,
        station: station.name,
        connectorType,
        date: bookingDate.toISOString().split('T')[0],
        startTime,
        endTime,
        durationMinutes,
        estimatedKWh,
        costBreakdown: {
          chargingCost: totalCost,
          platformFee,
          grandTotal,
          currency: pricing?.currency || 'INR',
        },
        status: booking.status,
        otp: `Your check-in OTP: ${otp}`,
      },
    });
  } catch (error) {
    next(error);
  }
};

const checkAvailability = async (req, res, next) => {
  try {
    const { stationId, date, connectorType } = req.query;

    const station = await Station.findById(stationId);
    if (!station) {
      return res.status(404).json({ success: false, message: 'Station not found' });
    }

    const queryDate = new Date(date);
    queryDate.setHours(0, 0, 0, 0);

    const matchQuery = {
      station: station._id,
      date: queryDate,
      $or: [
        { status: { $in: ['confirmed', 'in-progress'] } },
        { status: 'pending', createdAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) } }
      ],
    };
    
    if (connectorType) {
      matchQuery.connectorType = connectorType;
    }

    const bookings = await Booking.find(matchQuery).select(
      'startTime endTime connectorType status'
    );


    const [openTime, closeTime] = station.openingHours
      .split('-')
      .map((t) => t.trim());
    const openMin = timeToMinutes(openTime);
    const closeMin = timeToMinutes(closeTime);

    const maxPorts = connectorType
      ? (station.pricing.find((p) => p.connectorType === connectorType)?.portCount || station.availablePorts)
      : station.availablePorts;

    const slots = [];
    for (let min = openMin; min < closeMin; min += 30) {
      const slotStart = `${Math.floor(min / 60).toString().padStart(2, '0')}:${(min % 60).toString().padStart(2, '0')}`;
      const slotEnd = `${Math.floor((min + 30) / 60).toString().padStart(2, '0')}:${((min + 30) % 60).toString().padStart(2, '0')}`;


      let overlapping = 0;
      // Use Sweep Line for slot availability check too
      const slotEvents = [];
      for (const b of bookings) {
        const bStart = timeToMinutes(b.startTime);
        const bEnd = timeToMinutes(b.endTime);
        if (bStart < timeToMinutes(slotEnd) && bEnd > timeToMinutes(slotStart)) {
          slotEvents.push({ time: bStart, type: 1 });
          slotEvents.push({ time: bEnd, type: -1 });
        }
      }
      slotEvents.sort((a, b) => a.time - b.time || a.type);

      let maxOverlappingInSlot = 0;
      let currentInSlot = 0;
      // Initial count
      const slotStartMin = timeToMinutes(slotStart);
      for (const b of bookings) {
        if (slotStartMin >= timeToMinutes(b.startTime) && slotStartMin < timeToMinutes(b.endTime)) {
          currentInSlot++;
        }
      }
      maxOverlappingInSlot = currentInSlot;

      for (const e of slotEvents) {
        if (e.time >= timeToMinutes(slotEnd)) break;
        if (e.time > slotStartMin) {
          currentInSlot += e.type;
          if (currentInSlot > maxOverlappingInSlot) {
            maxOverlappingInSlot = currentInSlot;
          }
        }
      }
      overlapping = maxOverlappingInSlot;

      let isAvailable = overlapping < maxPorts;
      
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (queryDate < today) {
        isAvailable = false;
      } else if (queryDate.getTime() === today.getTime()) {
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        if (min < currentMinutes) {
          isAvailable = false;
        }
      }

      slots.push({
        startTime: slotStart,
        endTime: slotEnd,
        availablePorts: Math.max(0, maxPorts - overlapping),
        totalPorts: maxPorts,
        isAvailable,
      });
    }

    res.json({
      success: true,
      data: {
        station: station.name,
        date: queryDate.toISOString().split('T')[0],
        openingHours: station.openingHours,
        connectors: station.typeOfConnectors,
        slots,
      },
    });
  } catch (error) {
    next(error);
  }
};


const getUserBookings = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { status, page = 1, limit = 10 } = req.query;

    const query = { user: userId };
    if (status) {
      query.status = status;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [bookings, total] = await Promise.all([
      Booking.find(query)
        .populate('station', 'name address location contactInfo pricing')
        .sort({ date: -1, startTime: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Booking.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: bookings,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
};


const getBookingById = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.bookingId)
      .populate('station', 'name address location contactInfo pricing openingHours')
      .populate('user', 'name email vehicle');

    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }


    if (booking.user._id.toString() !== req.user.id) {
      const station = await Station.findById(booking.station._id);
      if (!station || station.ownerofStation.toString() !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }

    res.json({ success: true, data: booking });
  } catch (error) {
    next(error);
  }
};


const cancelBooking = async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    const { reason } = req.body;

    const booking = await Booking.findById(bookingId);

    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    if (booking.user.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'You can only cancel your own bookings',
      });
    }

    if (['cancelled', 'completed', 'in-progress'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel a booking that is already ${booking.status}`,
      });
    }


    const now = new Date();
    const bookingStart = new Date(booking.date);
    const [h, m] = booking.startTime.split(':').map(Number);
    bookingStart.setHours(h, m, 0, 0);

    const timeDiffMs = bookingStart.getTime() - now.getTime();
    const hoursUntilStart = timeDiffMs / (1000 * 60 * 60);

    let refundPercentage = 100;
    if (hoursUntilStart < 1) {
      refundPercentage = 0;
    } else if (hoursUntilStart < 4) {
      refundPercentage = 50;
    }

    booking.status = 'cancelled';
    booking.cancelledAt = now;
    booking.cancellationReason = reason || 'Cancelled by user';
    await booking.save();


    const io = req.app.get('io');
    if (io) {
      io.to(`station_${booking.station}`).emit('booking:cancelled', {
        bookingId: booking._id,
        stationId: booking.station,
        date: booking.date,
        startTime: booking.startTime,
        endTime: booking.endTime,
      });

      io.to(`user_${booking.user}`).emit('booking:cancelled', {
        bookingId: booking._id,
        status: 'cancelled',
      });
    }

    // Emit WebSocket event for capacity change
    if (io) {
      io.emit('station:capacity_changed', {
        stationId: booking.station,
        connectorType: booking.connectorType,
        status: booking.status,
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: 'Booking cancelled successfully',
      data: {
        bookingId: booking._id,
        refundPercentage,
        refundAmount: parseFloat(((booking.grandTotal * refundPercentage) / 100).toFixed(2)),
        cancellationPolicy:
          hoursUntilStart < 1
            ? 'No refund (less than 1 hour before start)'
            : hoursUntilStart < 4
              ? '50% refund (less than 4 hours before start)'
              : 'Full refund',
      },
    });
  } catch (error) {
    next(error);
  }
};


const checkIn = async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    const { otp } = req.body;

    const booking = await Booking.findById(bookingId).select('+otp +otpExpiresAt');

    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    const station = await Station.findById(booking.station);
    const isOwner = station && station.ownerofStation.toString() === req.user.id;

    if (!isOwner) {
      return res.status(403).json({ success: false, message: 'Only station owners can perform check-in.' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const bookingDate = new Date(booking.date);
    bookingDate.setHours(0, 0, 0, 0);

    if (today.getTime() !== bookingDate.getTime()) {
      return res.status(400).json({
        success: false,
        message: 'You can only check-in on the exact date of your booking.'
      });
    }

    if (booking.status !== 'confirmed') {
      return res.status(400).json({
        success: false,
        message: `Cannot check-in. Booking status is: ${booking.status}`,
      });
    }

    if (booking.otp !== otp) {
      return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }

    if (new Date() > booking.otpExpiresAt) {
      return res.status(400).json({ success: false, message: 'OTP has expired' });
    }

    booking.status = 'in-progress';
    booking.checkedInAt = new Date();
    booking.otp = undefined;
    booking.otpExpiresAt = undefined;
    await booking.save();


    const io = req.app.get('io');
    if (io) {
      io.to(`station_${booking.station}`).emit('booking:checkedIn', {
        bookingId: booking._id,
        stationId: booking.station,
        checkedInAt: booking.checkedInAt,
      });

      io.to(`user_${booking.user}`).emit('booking:checkedIn', {
        bookingId: booking._id,
        status: 'in-progress',
      });
    }

    res.json({
      success: true,
      message: 'Checked in successfully. Charging session started!',
      data: {
        bookingId: booking._id,
        status: booking.status,
        checkedInAt: booking.checkedInAt,
        endTime: booking.endTime,
      },
    });
  } catch (error) {
    next(error);
  }
};


const completeBooking = async (req, res, next) => {
  try {
    const { bookingId } = req.params;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }


    const station = await Station.findById(booking.station);
    const isOwner = station && station.ownerofStation.toString() === req.user.id;
    const isUser = booking.user.toString() === req.user.id;

    if (!isOwner && !isUser) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    if (booking.status !== 'in-progress') {
      return res.status(400).json({
        success: false,
        message: `Cannot complete. Booking status is: ${booking.status}`,
      });
    }

    booking.status = 'completed';
    booking.completedAt = new Date();
    await booking.save();


    const io = req.app.get('io');
    if (io) {
      io.to(`station_${booking.station}`).emit('booking:completed', {
        bookingId: booking._id,
        stationId: booking.station,
        completedAt: booking.completedAt,
      });

      io.to(`user_${booking.user}`).emit('booking:completed', {
        bookingId: booking._id,
        status: 'completed',
      });
    }

    res.json({
      success: true,
      message: 'Booking completed. Thank you for charging!',
      data: {
        bookingId: booking._id,
        status: booking.status,
        completedAt: booking.completedAt,
        grandTotal: booking.grandTotal,
      },
    });
  } catch (error) {
    next(error);
  }
};


const getStationBookings = async (req, res, next) => {
  try {
    const { stationId } = req.params;
    const { status, date, page = 1, limit = 20 } = req.query;

    const station = await Station.findById(stationId);
    if (!station) {
      return res.status(404).json({ success: false, message: 'Station not found' });
    }

    if (station.ownerofStation.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Only the station owner can view station bookings',
      });
    }

    const query = { station: stationId };
    if (status) query.status = status;
    if (date) {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      const nextDay = new Date(d);
      nextDay.setDate(nextDay.getDate() + 1);
      query.date = { $gte: d, $lt: nextDay };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [bookings, total] = await Promise.all([
      Booking.find(query)
        .populate('user', 'name email vehicle')
        .sort({ date: -1, startTime: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Booking.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: bookings,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
};

const validateBooking = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { station: stationId, connectorType, date, startTime, endTime } = req.body;

    const station = await Station.findById(stationId);
    if (!station) {
      return res.status(404).json({ success: false, message: 'Station not found' });
    }
    if (!station.isOpen) {
      return res.status(400).json({ success: false, message: 'Station is currently closed' });
    }
    if (station.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Station is inactive' });
    }

    if (!station.typeOfConnectors.includes(connectorType)) {
      return res.status(400).json({
        success: false,
        message: `This station does not support ${connectorType} connector. Available: ${station.typeOfConnectors.join(', ')}`,
      });
    }

    if (station.openingHours) {
      const [openTime, closeTime] = station.openingHours.split('-').map((t) => t.trim());
      const openMin = timeToMinutes(openTime);
      const closeMin = timeToMinutes(closeTime);
      const bookStartMin = timeToMinutes(startTime);
      const bookEndMin = timeToMinutes(endTime);

      if (bookStartMin < openMin || bookEndMin > closeMin) {
        return res.status(400).json({
          success: false,
          message: `Booking must be within station hours: ${station.openingHours}`,
        });
      }
    }

    const bookingDate = new Date(date);
    bookingDate.setHours(0, 0, 0, 0);

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (bookingDate < today) {
      return res.status(400).json({ success: false, message: 'Cannot book for a past date' });
    }

    if (bookingDate.getTime() === today.getTime()) {
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      if (timeToMinutes(startTime) <= currentMinutes) {
        return res.status(400).json({ success: false, message: 'Cannot book a time slot in the past for today' });
      }
    }

    const [existingBookings, userConflict] = await Promise.all([
      Booking.find({
        station: stationId,
        date: bookingDate,
        connectorType,
        $or: [
          { status: { $in: ['confirmed', 'in-progress'] } },
          { status: 'pending', createdAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) } }
        ],
      }),
      Booking.findOne({
        user: userId,
        date: bookingDate,
        $and: [
          {
            $or: [
              { status: { $in: ['confirmed', 'in-progress'] } },
              { status: 'pending', createdAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) } }
            ]
          },
          {
            $or: [
              {
                $and: [
                  { startTime: { $lt: endTime } },
                  { endTime: { $gt: startTime } },
                ],
              },
            ],
          }
        ]
      })
    ]);

    const requestedStart = timeToMinutes(startTime);
    const requestedEnd = timeToMinutes(endTime);
    
    const pricingConfig = station.pricing.find(p => p.connectorType === connectorType);
    const maxPorts = pricingConfig?.portCount || station.availablePorts;

    const events = [];
    for (const booking of existingBookings) {
      const bStart = timeToMinutes(booking.startTime);
      const bEnd = timeToMinutes(booking.endTime);
      if (bStart < requestedEnd && bEnd > requestedStart) {
        events.push({ time: bStart, type: 1 });
        events.push({ time: bEnd, type: -1 });
      }
    }
    events.sort((a, b) => a.time - b.time || a.type);

    let currentConcurrent = 0;
    for (const booking of existingBookings) {
      const bStart = timeToMinutes(booking.startTime);
      const bEnd = timeToMinutes(booking.endTime);
      if (requestedStart >= bStart && requestedStart < bEnd) {
        currentConcurrent++;
      }
    }

    if (currentConcurrent >= maxPorts) {
      const nextSlot = await findNextAvailableSlot(stationId, bookingDate, connectorType, startTime, requestedEnd - requestedStart, maxPorts, station.openingHours);
      return res.status(409).json({
        success: false,
        message: `No available ${connectorType} ports at ${startTime}.`,
        nextAvailableSlot: nextSlot,
        suggestion: nextSlot ? `Try booking at ${nextSlot} instead.` : 'Try a different date or station.',
      });
    }

    for (const event of events) {
      if (event.time >= requestedEnd) break;
      if (event.time > requestedStart) {
        if (currentConcurrent >= maxPorts) {
          const conflictTime = minutesToTime(event.time);
          const nextSlot = await findNextAvailableSlot(stationId, bookingDate, connectorType, startTime, requestedEnd - requestedStart, maxPorts, station.openingHours);
          return res.status(409).json({
            success: false,
            message: `No available ${connectorType} ports at ${conflictTime}. All ${maxPorts} ports are booked.`,
            nextAvailableSlot: nextSlot,
            suggestion: nextSlot ? `Try booking at ${nextSlot} instead.` : 'Try a different date or station.',
          });
        }
      }
      currentConcurrent += event.type;
    }

    if (userConflict) {
      return res.status(409).json({
        success: false,
        message: 'You already have an overlapping booking at this time',
        existingBooking: {
          startTime: userConflict.startTime,
          endTime: userConflict.endTime,
        },
      });
    }

    res.status(200).json({
      success: true,
      message: 'Slot is available and valid',
    });
  } catch (error) {
    next(error);
  }
};

const confirmAdvancePayment = async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    const booking = await Booking.findById(bookingId).populate('user').populate('station');

    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    
    // Check for 10-minute expiration
    if (booking.status === 'pending') {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      if (booking.createdAt < tenMinutesAgo) {
        booking.status = 'cancelled';
        booking.cancellationReason = 'Payment timeout (10 minutes)';
        await booking.save();
        return res.status(400).json({ success: false, message: 'Payment window expired (10 minutes). This booking has been cancelled.' });
      }
    }

    if (booking.status !== 'pending') return res.status(400).json({ success: false, message: `Cannot confirm. Booking is already ${booking.status}` });

    const otp = generateOtp();
    const otpExpiresAt = new Date(booking.date);
    const [endH, endM] = booking.endTime.split(':').map(Number);
    otpExpiresAt.setHours(endH, endM, 0, 0);

    booking.status = 'confirmed';
    booking.otp = otp;
    booking.otpExpiresAt = otpExpiresAt;
    await booking.save();

    const transporter = nodemailer.createTransport({
      secure: true,
      host: "smtp.gmail.com",
      port: Number(NODEMAILER_PORT),
      auth: {
        user: NODEMAILER_USER,
        pass: NODEMAILER_PASS
      }
    });

    const userInfo = booking.user;
    const station = booking.station;
    const date = booking.date.toISOString().split('T')[0];

    try {
      await transporter.sendMail({
        to: userInfo.email,
        subject: "EvGenee - Your Booking is Confirmed! \u26A1",
        html: `
        <div style="font-family: 'Inter', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 30px; border-radius: 12px; border: 1px solid #eaeaea; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
          <div style="text-align: center; margin-bottom: 25px;">
            <h1 style="color: #10B981; margin: 0; font-size: 28px;">EvGenee</h1>
            <p style="color: #6b7280; margin-top: 5px; font-size: 14px;">Your intelligent EV charging partner</p>
          </div>
          
          <h2 style="color: #111827; font-size: 20px; margin-bottom: 20px;">Booking Confirmed! 🎉</h2>
          <p style="color: #374151; font-size: 16px; line-height: 1.5;">Hi <strong>${userInfo.name}</strong>,</p>
          <p style="color: #374151; font-size: 16px; line-height: 1.5;">Your EV charging slot has been successfully reserved. Here are the details of your upcoming session:</p>
          
          <div style="background-color: #f9fafb; padding: 20px; border-radius: 8px; border: 1px solid #f3f4f6; margin: 25px 0;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; width: 40%;"><strong>Station</strong></td>
                <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 500;">${station.name}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-top: 1px solid #f3f4f6;"><strong>Location</strong></td>
                <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 500; border-top: 1px solid #f3f4f6;">${station.address.city}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-top: 1px solid #f3f4f6;"><strong>Date</strong></td>
                <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 500; border-top: 1px solid #f3f4f6;">${date}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-top: 1px solid #f3f4f6;"><strong>Time Slot</strong></td>
                <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 500; border-top: 1px solid #f3f4f6;">${booking.startTime} to ${booking.endTime}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-top: 1px solid #f3f4f6;"><strong>Connector</strong></td>
                <td style="padding: 8px 0; color: #111827; font-size: 15px; font-weight: 500; border-top: 1px solid #f3f4f6;">${booking.connectorType}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280; font-size: 14px; border-top: 1px solid #f3f4f6;"><strong>Est. Total</strong></td>
                <td style="padding: 8px 0; color: #10B981; font-size: 16px; font-weight: bold; border-top: 1px solid #f3f4f6;">₹${booking.grandTotal}</td>
              </tr>
            </table>
          </div>
  
          <p style="color: #374151; font-size: 16px; text-align: center; margin-top: 30px;">Your secure check-in OTP:</p>
          <div style="text-align: center; margin: 15px 0 30px 0;">
            <div style="display: inline-block; font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #059669; background-color: #ecfdf5; padding: 15px 30px; border-radius: 10px; border: 2px dashed #10B981;">
              ${otp}
            </div>
            <p style="color: #9ca3af; font-size: 12px; margin-top: 8px;">Please show this OTP at the station to begin charging.</p>
          </div>
          
          <hr style="border: none; border-top: 1px solid #eaeaea; margin: 30px 0;" />
          <p style="color: #9ca3af; font-size: 13px; text-align: center; margin: 0;">
            Thank you for choosing EvGenee!<br/>Drive safe, stay charged. ⚡
          </p>
        </div>`
      });
      console.log(`Confirmation email sent to ${userInfo.email} for booking ${booking._id}`);
    } catch (emailError) {
      console.error(`Failed to send confirmation email to ${userInfo.email}:`, emailError);
      // We continue since the booking is already saved as confirmed
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`user_${booking.user._id}`).emit('booking:created', {
        bookingId: booking._id,
        stationId: station._id,
        status: 'confirmed',
      });
      io.to(`station_${station._id}`).emit('booking:created', {
        stationId: station._id,
        bookingId: booking._id,
        connectorType: booking.connectorType,
        startTime: booking.startTime,
        endTime: booking.endTime,
        date: booking.date,
      });
    }

    res.status(200).json({ 
      success: true, 
      message: 'Booking confirmed', 
      data: {
        ...booking.toObject(),
        otp: otp
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createBooking,
  validateBooking,
  checkAvailability,
  getUserBookings,
  getBookingById,
  cancelBooking,
  checkIn,
  completeBooking,
  getStationBookings,
  confirmAdvancePayment,
};