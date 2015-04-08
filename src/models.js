'use strict';

// --------------------------------------------------
// manifest and children
// --------------------------------------------------
var DEFAULT_MIN_BUFFER_TIME = 30 * 1000;

export class Manifest extends Model {
    constructor(xml, url) {
        this.url = url;
        super(xml);
    }

    setup() {
        this.attrs({
            suggestedPresentationDelay: duration,
            mediaPresentationDuration:  duration,
            timeShiftBufferDepth:       duration,
            minimumUpdatePeriod:        duration,
            minBufferTime:              duration,
            availabilityStartTime:      date,
            profiles:                   str,
            type:                       str
        });

        // defined like this so a manifest is guaranteed either dynamic or not
        this.dynamic = (this.type == 'dynamic');
        this.static  = (!this.dynamic);

        // these durations are required when calculating segment URLs
        if (this.suggestedPresentationDelay == undefined)
            this.suggestedPresentationDelay = 0;
        if (this.availabilityStartTime == undefined)
            this.availabilityStartTime = 0;
        if (this.minBufferTime == undefined)
            this.minBufferTime = DEFAULT_MIN_BUFFER_TIME;

        this.init(BaseURL);
        this.initAll(Period);
    }

    // urls generated by segment templates will generally be relative urls.
    // to absolutify them, mpds can provide a BaseURL entry, or if that isn't
    // present, the URL of the mpd itself will be used.
    base() {
        if (!this._base) {
            if (this.baseURL)
                this._base = this.baseURL.absoluteTo(this.url);
            else
                this._base = URI(this.url).filename('').toString();
        }
        
        return this._base;
    }
}

export class BaseURL extends Model {
    setup() {
        this.url = this.xml.textContent;
    }

    absoluteTo(manifestURL) {
        let manifest = URI(manifestURL);
        let base = URI(this.url);
        return base.absoluteTo(manifest).toString();
    }
}

export class Period extends Model {
    setup() {
        this.attrs({
            id:         str,
            start:      duration,
            duration:   duration
        });

        this.init(SegmentTemplate);
        this.initAll(AdaptationSet);
    }
}


// --------------------------------------------------
// adaptation sets
// --------------------------------------------------
var commonAttributes = {
        startWithSAP:               integer,
        maximumSAPPeriod:           dbl,
        codingDependency:           bool,

        audioSamplingRate:          str,
        maxPlayoutRate:             dbl,
        frameRate:                  str,
        scanType:                   str,
        width:                      integer,
        height:                     integer,
        sar:                        str,

        segmentProfiles:            str,
        profiles:                   str,
        mimeType:                   str,
        codecs:                     str
};

export class AdaptationSet extends Model {
    setup() {
        this.attrs(commonAttributes, {
            subsegmentStartsWithSAP:    integer,
            segmentAlignment:           bool,
            subsegmentAlignment:        bool,

            maxFrameRate:               integer,
            maxWidth:                   integer,
            maxHeight:                  integer,
            contentType:                str,
            par:                        str,
            lang:                       str,

            group:                      integer,
            id:                         integer
        });

        this.index = AdaptationSet.nextIndex();

        this.initAll(ContentComponent);
        this.init(SegmentTemplate);
        this.initAll(Representation);

        // adaptation sets are required to have a mime type, but this
        // requirement isn't always obeyed
        if (this.mimeType == undefined)
            this.mimeType = this.representations[0].mimeType;
    }

    static nextIndex() {
        if (this._nextIndex == undefined)
            this._nextIndex = 0;
        this._nextIndex += 1;
        return this._nextIndex;
    }
}

export class ContentComponent extends Model {
    setup() {
        this.attrs({
            contentType: str,
            lang:        str,
            par:         str,
            id:          str
        });
    }
}

export class Representation extends Model {
    setup() {
        this.attrs(commonAttributes, {
            id:                     str,
            bandwidth:              integer,
            qualityRanking:         integer,
            dependencyId:           str,
            mediaStreamStructureId: str
        });

        // TODO: SegmentBase, SegmentList
        this.initAll(SubRepresentation);
        this.init(SegmentTemplate);
        this.init(BaseURL);

        this.inherit(AdaptationSet, Object.keys(commonAttributes));

        // fill in the representation's SegmentTemplate with a copy of the
        // template in AdaptationSet or Period if it doesn't exist
        if (!this.segmentTemplate) {
            let defaultTemplate = null;
            
            let adaptationSet = this.ancestor(AdaptationSet);
            if (adaptationSet && adaptationSet.segmentTemplate) {
                defaultTemplate = adaptationSet.segmentTemplate;
            } else {
                let period = this.ancestor(Period);
                if (period && period.segmentTemplate)
                    defaultTemplate = period.segmentTemplate;
            }

            if (!defaultTemplate)
                throw 'Representation must currently have a SegmentTemplate or one must appear in ancestry';
            this.segmentTemplate = new SegmentTemplate(defaultTemplate, this);
        }
    }

    mseType() {
        return `${this.mimeType}; codecs="${this.codecs}"`;
    }
}

export class SubRepresentation extends Model {
    setup() {
        this.attrs(commonAttributes, {
            level:            integer,
            bandwidth:        integer,
            dependencyLevel:  str,          // TODO: parse into list of SubRepr
            contentComponent: str
        });
    }
}


// --------------------------------------------------
// segments
// --------------------------------------------------
export class SegmentTemplate extends Model {
    setup() {
        this.attrs({
            bitstreamSwitching: str,
            initialization:     str,
            index:              str,
            media:              str,
            startNumber:        integer,
            timescale:          integer,
            duration:           integer, 
            presentationTimeOffset: integer
        });

        if (this.timescale == undefined)
            this.timescale = 1;

        if (this.startNumber == undefined)
            this.startNumber = 1;

        if (this.presentationTimeOffset == undefined)
            this.presentationTimeOffset = 0;

        this.init(SegmentTimeline);

        // inherit attributes from SegmentTemplates in Periods and AdaptationSets
        // NOTE: this means the call order to init is important - Period must init
        // SegmentTemplate before AdaptationSet and so on.
        let attrNames = Object.keys(this.attributeDefinitions);
        this.inheritFrom(AdaptationSet, 'segmentTemplate', attrNames);
        this.inheritFrom(Period, 'segmentTemplate', attrNames);
    }

    postSetup() {
        // initialise template strings in base SegmentTemplates - instances in
        // Period and AdaptationSet are used only as defaults for base instances
        if (this.parent instanceof Representation) {
            // save index and media strings before processing
            this.index_str = this.index;
            this.media_str = this.media;

            // parse templates
            let bitstreamSwitching  = new TemplateString('bitstreamSwitching', this);
            let initialization      = new TemplateString('initialization', this);
            this.index              = new TemplateString('index', this);
            this.media              = new TemplateString('media', this);

            // if any of templates are invalid, and this SegmentTemplate instance
            // is a child of a Representation, the parent Representation is invalid
            if (bitstreamSwitching.invalid ||
                initialization.invalid ||
                this.index.invalid ||
                this.media.invalid) {

                this.invalid = true;
                if (this.parent instanceof Representation)
                    this.parent.invalid = true;
            }

            // neither initialization nor bitstreamSwitching can include Time or
            // Number identifiers, so it's safe to use their pre-processed state
            this.bitstreamSwitching = bitstreamSwitching.processed;
            this.initialization = initialization.processed;
        }
    }

    aligned(other) {
        return  this.startNumber == other.startNumber &&
                this.timescale == other.timescale &&
                this.duration == other.duration;
    }

    clone(other) {
        other.bitstreamSwitching = this.bitstreamSwitching;
        other.initialization = this.initialization;
        other.index = this.index;
        other.media = this.media;
    }
}

export class SegmentTimeline extends Model {
    setup() {
        this.initAll(S);
    }
}

export class S extends Model {
    setup() {
        this.attrs({
            t: integer,     // time
            d: integer,     // duration
            r: integer      // num repeats
        });

        if (this.r == undefined)
            this.r = 0;
    }
}
