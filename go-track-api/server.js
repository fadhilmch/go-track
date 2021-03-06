'use strict';

const _ = require('lodash');
const express = require('express');
const bodyParser = require('body-parser');
const config = require('./config');
const logger = require('./logger');
const admin = require('firebase-admin');
const FirebaseService = require('./services/FirebaseService');
const LocationCalculatorService = require('./services/LocationCalculatorService');

admin.initializeApp({
    credential: admin.credential.cert(require('./secrets/firebase.json')),
    databaseURL: config.firebase.databaseUrl
});
const firebaseService = new FirebaseService();
const locationCalculatorService = new LocationCalculatorService(firebaseService);

const app = express();

const expressLogger = (req, res, next) => {
    logger.info(`[REQUEST LOGGER] ${req.method} ${req.url} with request header ${JSON.stringify(req.headers)} and body ${JSON.stringify(req.body)}`);
    next();
};

const jsonErrorHandler = (error, req, res, next) => {
    if (error instanceof SyntaxError) {
        res.status(400).json({ code: 400, message: 'Invalid JSON' });
    } else {
        next();
    }
};

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use(bodyParser.json());
app.use(jsonErrorHandler);
app.use(expressLogger);

app.get('/', (req, res) => {
    res.status(200).json({ message: 'Go-Track API' });
});

app.get('/firebase_test/:key', (req, res) => {
    firebaseService.get(req.params.key)
        .then((value) => {
            res.status(200).json(value);
        })
        .catch((err) => {
            res.status(500).json({
                code: 500,
                message: err.message || 'Unknown Error'
            });
        });
});

app.post('/firebase_test/:key', (req, res) => {
    firebaseService.set(req.params.key, req.body)
        .then((value) => {
            res.status(200).json(value);
        })
        .catch((err) => {
            res.status(500).json({
                code: 500,
                message: err.message || 'Unknown Error'
            });
        });
});

app.post('/location', (req, res) => {
    if (req.body.flag) {
        return handleFlaggedRequest(req, res);
    }
    if (!req.body.location || !req.body.location.longitude || !req.body.location.latitude) {
        return res.status(400).json({
            code: 400,
            message: 'Location data is invalid'
        });
    }
    if (!_.isArray(req.body.devices)) {
        return res.status(400).json({
            code: 400,
            message: 'Devices data is invalid'
        });
    }
    const baseLocationTimestamp = {
        timestamp: Date.now(),
        location: req.body.location
    };
    const baseAccuracy = req.body.location.accuracy || 20;

    const locationTimestamps = _.map(req.body.devices, (device) => {
        const accuracy = baseAccuracy + device.distance;
        const locationTimestamp = _.defaultsDeep({}, { location: { accuracy: accuracy }, id: device.id }, baseLocationTimestamp);
        return locationTimestamp;
    });

    const promises = _.map(locationTimestamps, (locationTimestamp) => {
        if (!locationTimestamp.id) return Promise.resolve();
        return firebaseService.storeRaw(locationTimestamp.id, locationTimestamp);
    });

    Promise.all(promises).then(() => {
        res.status(200).send();
        // run in background: calculating derived values
        setTimeout(() => {
            locationCalculatorService.calculateDerived(locationTimestamps);
        }, 0);
    }).catch((err) => {
        res.status(500).json({
            code: 500,
            message: `Error while updating data: ${err.message}`
        });
    });
});

const handleFlaggedRequest = (req, res) => {
    const flag = req.body.flag;
    firebaseService.get(`flag/${flag}`)
        .then((location) => {
            if (!location) {
                res.status(500).json({
                    code: 500,
                    message: `Error while updating data: flag ${flag} is empty`
                });
            }
            const baseLocationTimestamp = {
                timestamp: Date.now(),
                location: location
            };
            const baseAccuracy = location.accuracy || 20;

            const locationTimestamps = _.map(req.body.devices, (device) => {
                const accuracy = baseAccuracy + device.distance * location.multi;
                const locationTimestamp = _.defaultsDeep({}, { location: { accuracy: accuracy }, id: device.id }, baseLocationTimestamp);
                return locationTimestamp;
            });

            const promises = _.map(locationTimestamps, (locationTimestamp) => {
                if (!locationTimestamp.id) return Promise.resolve();
                return firebaseService.storeRaw(locationTimestamp.id, locationTimestamp);
            });

            Promise.all(promises).then(() => {
                res.status(200).send();
                // run in background: calculating derived values
                setTimeout(() => {
                    locationCalculatorService.calculateDerived(locationTimestamps);
                }, 0);
            }).catch((err) => {
                res.status(500).json({
                    code: 500,
                    message: `Error while updating data: ${err.message}`
                });
            });
        })
        .catch((err) => {
            logger.error('Error while handling flagged request', err);
            res.status(500).json({
                code: 500,
                message: `Error while updating data: ${err.message}`
            });
        });
};

app.get('/locationById/:deviceId', (req, res) => {
    const deviceId = req.params.deviceId;
    const n = req.query.n || 1;
    firebaseService.getLastLocations(deviceId, n)
        .then((data) => {
            if (!data) {
                res.status(404).json({
                    code: 404,
                    message: `No data found for device id ${deviceId}`
                });
            } else {
                res.status(200).json(data);
            }
        })
        .catch((err) => {
            res.status(500).json({
                code: 500,
                message: `Error while retrieving data: ${err.message}`
            });
        });
});

app.post('/trackee', (req, res) => {
    const trackee = req.body;
    firebaseService.updateTrackee(trackee)
        .then(() => {
            res.status(200).send();
        })
        .catch((err) => {
            res.status(500).json({
                code: 500,
                message: `Error while updating trackee: ${err.message}`
            });
        });
});

app.get('/trackee', (req, res) => {
    firebaseService.getTrackee()
        .then((trackees) => {
            res.status(200).json(trackees);
        })
        .catch((err) => {
            res.status(500).json({
                code: 500,
                message: `Error while getting trackee: ${err.message}`
            });
        });
});

app.get('/trackeeById/:trackeeId', (req, res) => {
    const trackeeId = req.params.trackeeId;
    firebaseService.getTrackeeById(trackeeId)
        .then((trackee) => {
            if (!trackee) {
                res.status(404).json({
                    code: 404,
                    message: `No trackee found with id ${trackeeId}`
                });
            } else {
                res.status(200).json(trackee);
            }
        })
        .catch((err) => {
            res.status(500).json({
                code: 500,
                message: `Error while getting trackee: ${err.message}`
            });
        });
});

// Unhandled 500
app.use((error, req, res, next) => {
    logger.error('Uncaught error: ', error);
    res.status(500).json({ message: 'Unknown Error', code: 500 });
});

const port = process.env.PORT || config.server.port;
const server = app.listen(port, () => {
    logger.info(`Go-Track API started on ${port}`);
});

module.exports = server;
