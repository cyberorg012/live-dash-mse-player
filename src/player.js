'use strict';

// Code Notes:
// - the classes in models.js are used to represent the raw data encoded by an
//   mpd file after a small amount of processing. e.g duration strings are
//   parsed to milliseconds, inheritence is applied, template strings are
//   processed etc.
// - the classes in player.js may also act as a model, and will sometimes wrap
//   a model object from models.js, but will extend it to help implement the
//   player. e.g Source 'wraps' an AdaptationSet, but includes logic for
//   selecting a Representation and creating buffers. some classes, like the
//   PresentationController, wrap multiple underlying models.
// - all downloads are run through a Downloader object (on a
//   PresentationController). download requests have an associated 'processor'
//   which is an object conforming to RequestProcessor. processors manage
//   responses, and are responsible for creating/removing/updating objects such
//   as Periods, and appending segment data to buffers.
// - actions which affect the state of the presentation are generally managed
//   by the PresentationController. so while an MPDProcessor creates/updates
//   Periods (which creates Sources etc.), the controller is responsible for
//   determining when to download init files, segments etc. i.e processors
//   deal with Requests and the controller deals with events generated by the
//   objects processors create.
// - some assumptions are made to simplify the code. some of these are required
//   by certain profiles (such as live and avc/h264), others exist because most
//   manifests "in the wild" satisfy the requirement. e.g: all periods will
//   contain the same number of adaptation sets. all equivalent adaptation sets
//   will contain the same number of representations, and each equivalent
//   representation will have the same mimeType and codec. bitrate/size
//   switching will be performed on representations only - adaptation sets are
//   assumed to represent tracks/sources, not representation options.


// --------------------------------------------------
// player
// --------------------------------------------------
// the Player class acts as a controller between the video
// element/media source object, and an instance of a
// PresentationController. The majority of the playback logic
// sits in the controller and other classes.
const VIDEO_EVENTS = [  'loadstart', 'emptied', 'canplay', 'canplaythrough',
                        'ended', 'progress', 'stalled', 'playing', 'suspend',
                        'loadedmetadata', 'waiting', 'abort', 'loadeddata',
                        'play', 'error', 'pause', 'durationchange', 'seeking',
                        'seeked'
                     ];

class Player {
    constructor(opts) {
        // TODO: ensure 'url' is provided
        this.options = Object.assign({
            pauseDetectInterval: 5,         // seconds
            debugInterval: 2,               // seconds

            mpdTimeout: 30,                 // seconds
            mpdReloadDelay: 0.2,            // seconds
            mpdMaxReloadAttempts: 5,

            noTimeshift: false              // true if live streams won't rewind
        }, opts);

        let player = this;

        // ---------------------------
        // video element
        // ---------------------------
        this.video = this.options.element;
        if (this.video.jquery)
            this.video = this.video[0];

        // for debugging - publicise all video events
        this.videoEventHandler = function(event) {
            console.log('video element event:', event.type);
        }

        for (let eventType of VIDEO_EVENTS) {
            this.video.addEventListener(eventType, this.videoEventHandler);
        }

        // detect when playback stops
        this.video.addEventListener('timeupdate',
            this.videoTimeUpdateEventHandler = function() {
                // every time currentTime changes, clear the timer and reset it
                // for pauseDetectInterval seconds. if playback continues it'll
                // be cleared again and again until playback stalls
                if (player.playbackTimer)
                    clearTimeout(player.playbackTimer);

                let interval = player.options.pauseDetectInterval;

                player.playbackTimer = setTimeout(() => {
                    // pause and end states validly stop playback
                    if (player.video.paused || player.video.ended)
                        return;
                    console.error(
                        `timeupdate not triggered for ${interval}s, playback stopped?`
                    );
                }, interval * 1000);
            }
        );


        // ---------------------------
        // backing media source
        // ---------------------------
        this.mediaSource = new MediaSource();
        this.video.src   = URL.createObjectURL(this.mediaSource);

        this.mediaSource.addEventListener('sourceopen',
            this.mseOpenHandler = function() {
                console.log('media source open');
                player.controller.loadManifest();
                player.emit('loading');
            }
        );

        this.mediaSource.addEventListener('sourceended',
            this.mseEndedHandler = function() {
                console.log('media source ended');
            }
        );

        this.mediaSource.addEventListener('sourceclose',
            this.mseCloseHandler = function() {
                console.log('media source closed');
            }
        );


        // ---------------------------
        // debug information
        // ---------------------------
        // show buffer info every second while playing
        this.bufferInfo = setInterval(() => {
            let current = this.video.currentTime;

            if (this.video.buffered.length > 0) {
                let last = this.video.buffered.end(0);
                let remaining = last - current;
                console.log('* time:', current, ' buffered:', last,
                            'remaining:', remaining);
            } else {
                console.log('* time:', current, ' buffered: nil');
            }
        }, this.options.debugInterval * 1000);


        // ---------------------------
        // controller
        // ---------------------------
        // instantiate the controller after the video element
        // and MS object are prepared. the sourceopen event
        // from the MS object starts the presentation.
        this.controller = new PresentationController(this);
    }


    // ---------------------------
    // destruction
    // ---------------------------
    destruct() {
        console.log('player destructing');
        this.emit('destructing');

        // allow the controller and presentation to destruct
        this.controller.destruct();
        this.controller = null;

        // detach video element event handlers
        this.video.removeEventListener('timeupdate', this.videoTimeUpdateEventHandler);
        for (let eventType of VIDEO_EVENTS) {
            this.video.removeEventListener(eventType, this.videoEventHandler);
        }

        // detach mse event handlers
        this.mediaSource.removeEventListener('sourceopen', this.mseOpenHandler);
        this.mediaSource.removeEventListener('sourceended', this.mseEndedHandler);
        this.mediaSource.removeEventListener('sourceclose', this.mseCloseHandler);

        // free the media source object and url
        this.video.pause();
        URL.revokeObjectURL(this.video.src);
        this.mediaSource = null;

        // clear timers
        clearTimeout(this.playbackTimer);
        clearInterval(this.bufferInfo);

        // cleanup the console
        console.groupEnd();
        console.log('destruction complete');
    }


    // ---------------------------
    // states/events
    // ---------------------------
    emit(eventType) {
        let event = new Event(`player:${eventType}`);
        this.video.dispatchEvent(event);
    }

    state() {
        return this.controller.state;
    }

    setDuration(newDuration) {
        this.mediaSource.duration = newDuration / 1000;
        console.log('set video duration to', this.mediaSource.duration);
        this.emit('durationChange');
    }

    setDimensions(width, height) {
        this.videoWidth = width;
        this.videoHeight = height;
        this.emit('dimensionChange');
    }
}


// updatePeriods(manifest) {
//     // ensure all periods in dynamic manifests have ids
//     if (manifest.dynamic) {
//         let anyMissingID = manifest.periods.some((period) => {
//             return period.id == undefined;
//         });

//         if (anyMissingID)
//             throw 'some periods in dynamic manifest are missing an id';
//     }

//     // updating the set of period involves removing periods that no longer
//     // appear in the manifest, updating periods that still exist, and
//     // adding new periods. the id to period map helps check for presence.
//     let controller = this.controller;
//     let existing = new Map([
//         for (period of controller.periods)
//             [period.id, period]
//     ]);

//     // add or update periods. as a period is discovered in the existing map
//     // its id is deleted. the remaining ids no longer exist in the manifest.
//     for (let period of manifest.periods) {
//         if (manifest.static || !existing.has(period.id)) {
//             controller.periods.push(new TimelinePeriod(period, controller));
//         } else {
//             existing.get(period.id).update(period);
//             existing.delete(period.id);
//         }
//     };

//     // any remaining ids have been deleted. only delete the period if the
//     // period ended before current presentation time - the timeshift buffer
//     controller.periods = controller.periods.filter((period) => {
//         // TODO: determine whether it's safe to delete the period
//         return controller.static || !existing.has(period.id);
//     });
// }


// --------------------------------------------------
// presentation controller
// --------------------------------------------------
class PresentationController {
    constructor(player) {
        this.player             = player;
        this.options            = player.options;
        this.state              = PresentationController.uninitialised;

        // mpd downloading and processing
        this.loadingManifest    = false;
        this.downloader         = new Downloader(this);
        this.processor          = new MPDProcessor(this);
        this.presentation       = new Presentation(this);
        this.manifestURL        = player.options.url;
        this.manifestLoaded     = undefined;
    }

    setState(newState) {
        if (this.state == newState)
            return;
        this.state = newState;
        this.player.emit('stateChanged');

        console.groupEnd();
        console.group();
        console.log(
            performance.now().toFixed(2),
            'state now:', PresentationController.stateNames[newState]
        );
    }

    destruct() {
        if (this.tickInterval)
            clearInterval(this.tickInterval);
        this.downloader.destruct();
        this.presentation.destruct();
    }


    // ---------------------------
    // manifests
    // ---------------------------
    loadManifest() {
        if (this.loadingManifest)
            return;

        console.log('loading manifest from', this.options.url);
        this.downloader.getMPD(this.options.url, this.processor);
        this.loadingManifest = true;
    }

    loadedManifest(manifest) {
        if (this.state == PresentationController.uninitialised)
            this.setState(PresentationController.firstMPDLoaded);

        // dynamic manifests to be reloaded at manifestLoaded +
        // manifest.minimumUpdatePeriod
        this.manifestLoaded = performance.now();
        console.log('loaded manifest', manifest);
        this.loadingManifest = false;

        // add the manifest to the presentation. presentation will process
        // the manifest and add/remove periods and sources as required
        this.presentation.appendManifest(manifest);
    }

    // ---------------------------
    // presentation initialisation
    // ---------------------------
    sourcesPrepared() {
        console.log('selecting sources and creating buffers');
        let video = this.player.video;
        let initialisedTypes = new Map();        

        // attempt to create buffers for sources with compatible media types
        for (let source of this.presentation.sources) {
            // empty response indicates the media engine cannot play this type
            if (video.canPlayType(source.mseType) == '')
                continue;

            // don't create e.g 2 video sources
            if (initialisedTypes.has(source.contentType))
                continue;

            try {
                source.createBuffer();
                initialisedTypes.set(source.contentType, source);
                console.log('using', source.mseType, 'for', source.contentType);
            } catch(e) {
                console.log(source.mseType, 'error creating buffer', e.stack);
                this.player.emit('errorCreatingBuffers');
            }
        }
        
        // this player doesn't deal with audio only presentations
        let videoSource = initialisedTypes.get('video');
        if (videoSource == undefined) {
            this.player.emit('noValidVideoSource');
            throw 'player could not initialise a valid video source';
        }

        // otherwise set the initial player dimensions
        this.player.setDimensions(videoSource.width(), videoSource.height());

        // remaining sources will not be in the bufferCreated state because
        // they have an incompatible mimetype, or have a contentType already
        // initialised by another source before it.
        let presentation = this.presentation;
        presentation.sources = presentation.sources.filter((source) => {
            return source.state == Source.bufferCreated;
        });

        this.setState(PresentationController.sourceBuffersCreated);
        console.log('buffers created, waiting for init files');

        // all sources have an initialisation 'header' file to be loaded to the
        // source's buffer before any content segments are appended
        for (let source of presentation.sources) {
            source.loadInitFile();
            console.log(
                'starting', source.contentType,
                'with bandwidth:', source.bandwidth,
                'width:', source.width(),
                'height:', source.height()
            );
        }
    }

    sourceInitialised() {
        let sources = this.presentation.sources;

        // wait until all sources are successfully initialised to prevent
        // downloading segments unnecessarily
        let allInitialised =
            sources.every(source => source.state == Source.initialised);
        if (!allInitialised)
            return;

        // transition
        this.setState(PresentationController.sourcesInitialised);
        console.log('all sources initialised, buffering segments');

        // seek to an initial start or live edge and begin buffering segments
        this.tickInterval = setInterval(() => {
            this.tick();
        }, 100);
    }


    // ---------------------------
    // buffering
    // ---------------------------
    tick() {
        let manifest = this.presentation.manifest;

        // reload the manifest if minimumUpdatePeriod has passed
        if (manifest.dynamic && manifest.minimumUpdatePeriod) {
            let timeSinceManifest = performance.now() - this.manifestLoaded;
            if (timeSinceManifest >= manifest.minimumUpdatePeriod)
                this.loadManifest();
        }
        
        // keep buffering until at least minBufferTime is remaining
        let video = this.player.video;
        let current = video.currentTime;
        let remaining = 0;

        if (video.buffered.length > 0) {
            let last = video.buffered.end(0);
            remaining = last - current;
        }

        let minBuffer = (manifest.minBufferTime / 1000);
        minBuffer *= 2;

        if (remaining < minBuffer) {
            for (let source of this.presentation.sources) {
                source.timeline.currentPeriod.downloadNextSegment();
            }

        } else {
            if (this.state == PresentationController.sourcesInitialised) {
               this.setState(PresentationController.bufferAvailable);
               video.currentTime = video.buffered.start(0);
               video.play();
           }
        }
    }
}

// controller states
PresentationController.uninitialised = 0;
PresentationController.firstMPDLoaded = 1;
PresentationController.sourceBuffersCreated = 2;
PresentationController.sourcesInitialised = 3;
PresentationController.bufferAvailable = 4;

PresentationController.stateNames = [
    'uninitialised',
    'firstMPDLoaded',
    'sourceBuffersCreated',
    'sourcesInitialised',
    'bufferAvailable'
];
