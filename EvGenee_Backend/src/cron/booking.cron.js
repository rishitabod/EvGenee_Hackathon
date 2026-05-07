const Booking = require('../models/booking.model');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { NODEMAILER_USER, NODEMAILER_PASS, NODEMAILER_PORT } = require('../config/config');

const transporter = nodemailer.createTransport({
    secure: true,
    host: "smtp.gmail.com",
    port: Number(NODEMAILER_PORT),
    auth: {
        user: NODEMAILER_USER,
        pass: NODEMAILER_PASS
    }
});
const initializeCronJobs = (io) => {

    cron.schedule('*/15 * * * *', async () => {
        try {
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    
            const noShows = await Booking.updateMany(
                {
                    status: 'confirmed',
                    date: { $lte: today },
                    endTime: { $lt: currentTime },
                },
                {
                    $set: { status: 'no-show' },
                }
            );

            if (noShows.modifiedCount > 0) {
                console.log(`[CRON] Marked ${noShows.modifiedCount} bookings as no-show`);
            }
        } catch (error) {
            console.error('[CRON] Error marking no-shows:', error.message);
        }
    });

  
    cron.schedule('*/10 * * * *', async () => {
        try {
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

            const autoCompleted = await Booking.updateMany(
                {
                    status: 'in-progress',
                    date: { $lte: today },
                    endTime: { $lte: currentTime },
                },
                {
                    $set: {
                        status: 'completed',
                        completedAt: now,
                    },
                }
            );

            if (autoCompleted.modifiedCount > 0) {
                console.log(`[CRON] Auto-completed ${autoCompleted.modifiedCount} bookings`);
            
                if (io) {
                    io.emit('bookings:autoCompleted', {
                        count: autoCompleted.modifiedCount,
                        timestamp: now,
                    });
                }
            }
        } catch (error) {
            console.error('[CRON] Error auto-completing bookings:', error.message);
        }
    });

 
    cron.schedule('* * * * *', async () => {
        try {
            const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

            const expired = await Booking.updateMany(
                {
                    status: 'pending',
                    createdAt: { $lt: tenMinutesAgo },
                },
                {
                    $set: { status: 'cancelled', cancellationReason: 'Auto-cancelled: Booking expired' },
                }
            );

            if (expired.modifiedCount > 0) {
                console.log(`[CRON] Expired ${expired.modifiedCount} pending bookings`);
                if (io) {
                    io.emit('station:capacity_changed', {
                        type: 'expiration',
                        count: expired.modifiedCount,
                        timestamp: now,
                    });
                }
            }
        } catch (error) {
            console.error('[CRON] Error expiring pending bookings:', error.message);
        }
    });

    // Reminder Cron: Run every minute to find bookings starting in 15 minutes
    cron.schedule('* * * * *', async () => {
        try {
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            
            const reminderDate = new Date(Date.now() + 15 * 60 * 1000);
            const reminderTimeStr = `${reminderDate.getHours().toString().padStart(2, '0')}:${reminderDate.getMinutes().toString().padStart(2, '0')}`;

            const upcomingBookings = await Booking.find({
                status: 'confirmed',
                date: { $eq: today },
                startTime: reminderTimeStr,
                reminderSent: false
            }).populate('user', 'name email');

            for (const b of upcomingBookings) {
        
                await transporter.sendMail({
                    to: b.user.email,
                    subject: "⚡ Reminder: Your Charging Session starts in 15 mins!",
                    html: `
                        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                            <h2>Hello ${b.user.name},</h2>
                            <p>Your EV charging session is scheduled to start at <b>${b.startTime}</b>.</p>
                            <p>Please arrive at the station a few minutes early.</p>
                            <div style="background: #f4f4f4; padding: 15px; border-radius: 8px; margin: 20px 0;">
                                <p><b>Status:</b> Ready to Charge</p>
                                <p><b>Vehicle Number:</b> ${b.vehicleNumber || 'N/A'}</p>
                            </div>
                            <p>Happy Charging!<br/>Team EvGenee</p>
                        </div>
                    `
                });

                // Send Socket Notification
                if (io) {
                    io.to(`user_${b.user._id}`).emit('booking:reminder', {
                        message: `Your charging session starts at ${b.startTime}. Be ready!`,
                        bookingId: b._id
                    });
                }

                b.reminderSent = true;
                await b.save();
                console.log(`[CRON] Reminder sent to ${b.user.email} for booking ${b._id}`);
            }
        } catch (error) {
            console.error('[CRON] Error sending reminders:', error.message);
        }
    });
};

module.exports = { initializeCronJobs };
