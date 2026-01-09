/**
 * Middleware de sécurité - Rate Limiting
 * Limite le nombre de requêtes par IP pour éviter les abus
 */

import rateLimit from 'express-rate-limit';

// Rate limiter général (100 requêtes par 15 minutes)
export const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limite de 100 requêtes par fenêtre
    message: {
        error: 'Trop de requêtes depuis cette IP, veuillez réessayer dans 15 minutes.'
    },
    standardHeaders: true, // Retourne les infos de rate limit dans les headers `RateLimit-*`
    legacyHeaders: false, // Désactive les headers `X-RateLimit-*`
    handler: (req, res) => {
        console.warn(`Rate limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            error: 'Trop de requêtes',
            message: 'Vous avez dépassé la limite de requêtes. Veuillez réessayer dans quelques minutes.',
            retryAfter: '15 minutes'
        });
    }
});

// Rate limiter strict pour les routes sensibles (10 requêtes par 15 minutes)
export const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: {
        error: 'Trop de tentatives, veuillez réessayer plus tard.'
    },
    skipSuccessfulRequests: true, // Ne compte que les requêtes échouées
    handler: (req, res) => {
        console.warn(`Strict rate limit exceeded for IP: ${req.ip} on ${req.path}`);
        res.status(429).json({
            error: 'Trop de tentatives',
            message: 'Vous avez dépassé la limite de tentatives. Veuillez réessayer dans 15 minutes.',
            retryAfter: '15 minutes'
        });
    }
});

// Rate limiter pour les API (50 requêtes par minute)
export const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 50,
    message: {
        error: 'Trop de requêtes API'
    },
    standardHeaders: true,
    legacyHeaders: false
});

// Rate limiter pour les exports (5 par heure)
export const exportLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 heure
    max: 5,
    message: {
        error: 'Limite d\'exports atteinte'
    },
    handler: (req, res) => {
        console.warn(`Export limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            error: 'Limite d\'exports atteinte',
            message: 'Vous avez atteint la limite d\'exports pour cette heure. Veuillez réessayer plus tard.',
            retryAfter: '1 heure'
        });
    }
});

// Rate limiter pour les modifications (300 par minute - DEV MODE)
export const mutationLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 300,
    message: {
        error: 'Trop de modifications'
    }
});

// Rate limiter pour les APIs externes (géocodage)
export const geoLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: {
        error: 'Limite de géocodage atteinte. Veuillez patienter.'
    },
    standardHeaders: true,
    legacyHeaders: false
});

// Rate limiter pour les scans GPS (opération lourde)
export const scanLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 1,
    message: {
        error: 'Un scan GPS est déjà en cours. Veuillez patienter 5 minutes.'
    },
    standardHeaders: true,
    legacyHeaders: false
});
