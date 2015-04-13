class SegmentWindow extends PlayerObject {
    constructor(source) {
        this.source         = source;
        this.presentation   = source.presentation;
        this.timeline       = source.presentation.timeline;

        this.segments       = [];
        this.playIndex      = undefined;
        this.loadIndex      = undefined;
        this.nextRangeStart = undefined;
    }

    // ---------------------------
    // update segment list
    // ---------------------------
    update() {
        if (this.presentation.willStartAtBeginning)
            this.updateStatic();
        else
            this.updateDynamic();
    }

    // called once at presentation start - generate and load all segments
    updateStatic() {
        let duration = this.timeline.duration;
        if (duration == undefined)
            throw 'cannot play static presentation with unknown duration';

        this.segments = this.source.segmentsInRange(0, duration);
        this.loadIndex = 0;
    }

    // called every time the manifest is loaded
    updateDynamic() {
        console.group();
        console.log(`updating ${this.source.contentType} segments`);
        if (this.nextRangeStart != undefined)
            console.log(`from ${this.nextRangeStart.toFixed(2)}`);

        // add segments from the end of the last segment to the new live edge
        let liveEdge = this.presentation.liveEdge();
        let edgeSegment = this.source.segmentAt(liveEdge);
        let rangeStart = this.nextRangeStart;
        let rangeEnd = liveEdge;

        // if no segments have ever been added, choose a start based on the
        // live edge, moving back a little to help ensure continuous streaming
        if (rangeStart == undefined) {
            // because of slight timing differences, the edge segment may not
            // always be found. try and use the last available timeline segment
            // if it makes sense, or change the search to the pres. end time.
            if (!edgeSegment) {
                let content = this.source.contentAt(liveEdge);
                if (content.repeatSegment) {
                    edgeSegment = content.segmentAt(this.presentation.endTime);
                } else {
                    let candidates = content.segments;
                    edgeSegment = candidates[candidates.length - 1];
                }
            }

            rangeStart = edgeSegment.start;

            // we need to ensure start doesn't fall outside the timeshift range
            let manifest = this.presentation.manifest;
            let timeshift = manifest.timeShiftBufferDepth;
            let minStart = rangeStart - timeshift;

            // if a suggested delay is provided, move back by that many seconds
            if (manifest.suggestedPresentationDelay) {
                rangeStart -= manifest.suggestedPresentationDelay;

            // otherwise use the timeshift buffer to determine the start time
            } else {
                rangeStart -= timeshift / 2;
            }

            // ensure rangeStart falls on a valid segment
            rangeStart = Math.max(rangeStart, minStart);    // time >= now - timeshift
            rangeStart = Math.max(rangeStart, 0);           // time >= 0
            let startDiff = liveEdge - rangeStart;
            console.log(`queueing ${startDiff.toFixed(2)}s from live edge`);
        }

        // grab the segments in the range and start to merge into the existing
        // segments list. the initial update will assign the first set of
        // segments to the list, subsequent updates are based on the end time
        // of the last segment added previously, so no overlaps should occur
        // other than the last and first new segments being equal.
        console.log(`queueing ${rangeStart.toFixed(2)} to`,
                    `${rangeEnd.toFixed(2)}`);
        let newSegments = this.source.segmentsInRange(rangeStart, rangeEnd);

        if (newSegments.length == 0) {
            console.warn('no segments produced over this range');
            console.groupEnd();
            return;
        }

        let startOffset = liveEdge - newSegments[0].start;
        console.log(`got ${newSegments.length} segment(s), starting`,
            newSegments[0].start.toFixed(2), 'ending',
            newSegments[newSegments.length - 1].end.toFixed(2),
            `, ${startOffset.toFixed(2)}s from live edge` 
        );

        if (this.segments.length > 0) {
            let lastSegment = this.segments[this.segments.length - 1];
            if (lastSegment.equal(newSegments[0]))
                newSegments.splice(0, 1);

            let lastEnd = lastSegment.end;
            if (lastEnd != newSegments[0].start)
                console.error('discontiguous segments');

            this.segments = this.segments.concat(newSegments);
        } else {
            this.segments = newSegments;
        }

        // the next update will load from the end of the last segment
        this.nextRangeStart = newSegments[newSegments.length - 1].end;
        this.loadIndex = this.loadIndex || 0;

        // debug output
        let duration = 0.0;
        for (let segment of newSegments)
            duration += segment.durationSeconds;

        let time = performance.now() - this.presentation.controller.timeBase;
        console.log(time.toFixed(2),
            `queued ${newSegments.length} ${this.source.contentType}`,
            `segment(s) adding ${duration.toFixed(2)}s`,
            `window is now ${this.segments.length} wide`
        );
        
        console.groupEnd();
    }


    // ---------------------------
    // segment management
    // ---------------------------
    downloadNextSegment() {
        if (this.loadIndex == undefined)
            return;

        let segment = this.segments[this.loadIndex];

        // if the segment is downloading, allow it to continue
        if (segment.state == Segment.downloading)
            return;

        // if the segment is downloaded (or errored) attempt to move to the
        // next segment for downloading
        if (segment.state >= Segment.downloaded) {

            // if this is the last segment in the queue...
            if ((this.loadIndex + 1) == this.segments.length) {
                // the last segment may be the last segment available in the
                // presentation. don't perform any processing in this case.
                let duration = this.presentation.timeline.duration;
                if (duration && segment.end >= duration)
                    return;

                // if we're already attempting to load new segments, allow the
                // manifest re-load to continue
                let controller = this.presentation.controller;
                if (controller.loadingManifest)
                    return;

                // debug info
                let time = performance.now() - controller.timeBase;
                console.warn(
                    time.toFixed(2), this.source.contentType,
                    'queue has run empty, last segment is downloaded'
                );

                // attempt to load more segments from the manifest. if the
                // period uses a segment template or ends in a repeating
                // segment, we can generate new segments from liveEdge to
                // presentation end time.
                

                // if no new segments could be found in the existing manifest,
                // try reloading the manifest early
                console.log('no segments remain in manifest, reloading');
                this.presentation.controller.loadManifest();
                return;

            // otherwise we can cleanly move to the next segment in the queue
            } else {
                this.loadIndex += 1;
                segment = this.segments[this.loadIndex];
            }
        }

        // wait until the segment can be downloaded
        if (!segment.available()) {
            let remaining = segment.end - this.presentation.liveEdge();
            console.log(`segment isnt available yet ${remaining.toFixed(2)}s to go`);
            return;
        }

        // only remaining segment state is pending. start to download.
        segment.state = Segment.downloading;

        // cache the url, this locks it to the current representation
        let url = segment.url(true);

        this.presentation.controller.downloader.getMedia(url, segment);
        console.log('downloading', this.source.contentType, 'segment', url);
    }

    undownloadedSegmentsRemaining() {
        this.segments.length - this.loadIndex - 1;
    }


};
