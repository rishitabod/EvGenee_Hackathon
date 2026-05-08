const { body, param, query } = require('express-validator');
const mongoose = require('mongoose');

const createBookingValidation = [
    body('station')
        .notEmpty().withMessage('Station ID is required')
        .custom((value) => {
            if (!mongoose.Types.ObjectId.isValid(value)) {
                throw new Error('Invalid Station ID format');
            }
            return true;
        }),

    body('connectorType')
        .trim()
        .notEmpty().withMessage('Connector type is required')
        .isIn(['CCS2', 'CHAdeMO', 'Type2', 'Type1', 'Tesla']).withMessage('Invalid connector type'),

    body('date')
        .notEmpty().withMessage('Booking date is required')
        .isISO8601().withMessage('Date must be a valid ISO 8601 date')
        .custom((value) => {
            const bookingDate = new Date(value);
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const bDay = new Date(bookingDate.getFullYear(), bookingDate.getMonth(), bookingDate.getDate());
            if (bDay < today) {
                throw new Error('Booking date cannot be in the past');
            }
        
            const maxDate = new Date(today);
            maxDate.setDate(maxDate.getDate() + 30);
            if (bDay > maxDate) {
                throw new Error('Cannot book more than 30 days in advance');
            }
            return true;
        }),

    body('startTime')
        .notEmpty().withMessage('Start time is required')
        .matches(/^([01]\d|2[0-3]):([0-5]\d)$/).withMessage('Start time must be in HH:MM (24-hour) format'),

    body('endTime')
        .notEmpty().withMessage('End time is required')
        .matches(/^([01]\d|2[0-3]):([0-5]\d)$/).withMessage('End time must be in HH:MM (24-hour) format')
        .custom((value, { req }) => {
            if (!req.body.startTime) return true;
            const [startH, startM] = req.body.startTime.split(':').map(Number);
            const [endH, endM] = value.split(':').map(Number);
            const startMinutes = startH * 60 + startM;
            const endMinutes = endH * 60 + endM;
            if (endMinutes <= startMinutes) {
                throw new Error('End time must be after start time');
            }
            const duration = endMinutes - startMinutes;
            if (duration < 60) {
                throw new Error('Booking duration cannot be less than 1 hour');
            }
            if (duration > 480) {
                throw new Error('Maximum booking duration is 8 hours');
            }
            return true;
        }),

    body('vehicleNumber')
        .optional()
        .trim()
        .isLength({ min: 4, max: 20 }).withMessage('Vehicle number must be between 4 and 20 characters'),
];

const cancelBookingValidation = [
    param('bookingId')
        .notEmpty().withMessage('Booking ID is required')
        .custom((value) => {
            if (!mongoose.Types.ObjectId.isValid(value)) {
                throw new Error('Invalid Booking ID format');
            }
            return true;
        }),
];

const checkAvailabilityValidation = [
    query('stationId')
        .notEmpty().withMessage('Station ID is required')
        .custom((value) => {
            if (!mongoose.Types.ObjectId.isValid(value)) {
                throw new Error('Invalid Station ID format');
            }
            return true;
        }),

    query('date')
        .notEmpty().withMessage('Date is required')
        .isISO8601().withMessage('Date must be a valid ISO 8601 date'),

    query('connectorType')
        .optional()
        .isIn(['CCS2', 'CHAdeMO', 'Type2', 'Type1', 'Tesla']).withMessage('Invalid connector type'),
];

module.exports = {
    createBookingValidation,
    cancelBookingValidation,
    checkAvailabilityValidation,
};
