/**
 * Copyright 2017 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Amazon Software License (the "License"). You may not use this file except in compliance with the License. A copy of the License is located at
 *
 *   http://aws.amazon.com/asl/
 *
 * or in the "LICENSE" file accompanying this file. This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
import { hitch, wrapLogger, closeStream } from './utils';
import { SessionReport } from './session_report';
import { DEFAULT_ICE_TIMEOUT_MS, DEFAULT_GUM_TIMEOUT_MS, RTC_ERRORS } from './rtc_const';
import { UnsupportedOperation, IllegalParameters, IllegalState, GumTimeout, BusyExceptionName, CallNotFoundExceptionName } from './exceptions';
import RtcSignaling from './signaling';
import uuid from 'uuid/v4';
import {extractAudioStatsFromStats} from './rtp-stats';

export class RTCSessionState {
    constructor(rtcSession) {
        this._rtcSession = rtcSession;
    }
    onEnter() {
    }
    onExit() {
    }
    _isCurrentState() {
        return this._rtcSession._state === this;
    }
    transit(nextState) {
        if (this._isCurrentState()) {
            this._rtcSession.transit(nextState);
        }
    }
    get logger() {
        return this._rtcSession._logger;
    }
    hangup() {
        this.transit(new FailedState(this._rtcSession));
    }
    onIceCandidate(evt) {// eslint-disable-line no-unused-vars
        //ignore candidate by default, ConnectSignalingAndIceCollectionState will override to collect candidates, but collecting process could last much longer than ConnectSignalingAndIceCollectionState
        //we don't want to spam the console log
    }
    onRemoteHungup() {
        throw new UnsupportedOperation('onRemoteHungup not implemented by ' + this.name);
    }
    get name() {
        return "RTCSessionState";
    }
    onSignalingConnected() {
        throw new UnsupportedOperation('onSignalingConnected not implemented by ' + this.name);
    }
    onSignalingHandshaked() {
        throw new UnsupportedOperation('onSignalingHandshaked not implemented by ' + this.name);
    }
    onSignalingFailed(e) {// eslint-disable-line no-unused-vars
        throw new UnsupportedOperation('onSignalingFailed not implemented by ' + this.name);
    }
}
export class GrabLocalMediaState extends RTCSessionState {
    onEnter() {
        var self = this;
        var startTime = Date.now();
        if (self._rtcSession._userAudioStream) {
            self.transit(new CreateOfferState(self._rtcSession));
        } else {
            var gumTimeoutPromise = new Promise((resolve, reject) => {
                setTimeout(() => {
                    reject(new GumTimeout('Local media has not been initialized yet.'));
                }, self._rtcSession._gumTimeoutMillis);
            });
            var sessionGumPromise = self._gUM(self._rtcSession._buildMediaConstraints());

            Promise.race([sessionGumPromise, gumTimeoutPromise])
                .then(stream => {
                    self._rtcSession._sessionReport.gumTimeMillis = Date.now() - startTime;
                    self._rtcSession._onGumSuccess(self._rtcSession);
                    self._rtcSession._streamToBeClosed = stream;
                    self._rtcSession._sessionReport.gumOtherFailure = false;
                    self._rtcSession._sessionReport.gumTimeoutFailure = false;
                    self.transit(new CreateOfferState(self._rtcSession));
                }).catch(e => {
                    self._rtcSession._sessionReport.gumTimeMillis = Date.now() - startTime;
                    var errorReason;
                    if (e instanceof GumTimeout) {
                        errorReason = RTC_ERRORS.GUM_TIMEOUT_FAILURE;
                        self._rtcSession._sessionReport.gumTimeoutFailure = true;
                        self._rtcSession._sessionReport.gumOtherFailure = false;
                    } else {
                        errorReason = RTC_ERRORS.GUM_OTHER_FAILURE;
                        self._rtcSession._sessionReport.gumOtherFailure = true;
                        self._rtcSession._sessionReport.gumTimeoutFailure = false;
                    }
                    self.logger.error('Local media initialization failed', e);
                    self._rtcSession._onGumError(self._rtcSession);
                    self.transit(new FailedState(self._rtcSession, errorReason));
                });
        }
    }
    get name() {
        return "GrabLocalMediaState";
    }
    _gUM(constraints) {
        return navigator.mediaDevices.getUserMedia(constraints);
    }
}
export class CreateOfferState extends RTCSessionState {
    onEnter() {
        var self = this;
        var stream = self._rtcSession._streamToBeClosed || self._rtcSession._userAudioStream;
        self._rtcSession._pc.addStream(stream);
        self._rtcSession._onLocalStreamAdded(self._rtcSession, stream);
        self._rtcSession._pc.createOffer().then(rtcSessionDescription => {
            self._rtcSession._localSessionDescription = rtcSessionDescription;
            self._rtcSession._sessionReport.createOfferFailure = false;
            self.transit(new SetLocalSessionDescriptionState(self._rtcSession));
        }).catch(e => {
            self.logger.error('CreateOffer failed', e);
            self._rtcSession._sessionReport.createOfferFailure = true;
            self.transit(new FailedState(self._rtcSession, RTC_ERRORS.CREATE_OFFER_FAILURE));
        });
    }
    get name() {
        return "CreateOfferState";
    }
}
export class SetLocalSessionDescriptionState extends RTCSessionState {
    onEnter() {
        var self = this;

        // fix/modify SDP as needed here

        self.logger.info('LocalSD', self._rtcSession._localSessionDescription);
        self._rtcSession._pc.setLocalDescription(self._rtcSession._localSessionDescription).then(() => {
            var initializationTime = Date.now() - self._rtcSession._connectTimeStamp;
            self._rtcSession._sessionReport.initializationTimeMillis = initializationTime;
            self._rtcSession._onSessionInitialized(self._rtcSession, initializationTime);
            self._rtcSession._sessionReport.setLocalDescriptionFailure = false;
            self.transit(new ConnectSignalingAndIceCollectionState(self._rtcSession));
        }).catch(e => {
            self.logger.error('SetLocalDescription failed', e);
            self._rtcSession._sessionReport.setLocalDescriptionFailure = true;
            self.transit(new FailedState(self._rtcSession, RTC_ERRORS.SET_LOCAL_DESCRIPTION_FAILURE));
        });
    }
    get name() {
        return "SetLocalSessionDescriptionState";
    }
}
export class ConnectSignalingAndIceCollectionState extends RTCSessionState {
    constructor(rtcSession) {
        super(rtcSession);
        this._iceCandidates = [];
        this._iceCandidateFoundationsMap = {};
    }
    onEnter() {
        var self = this;
        self._startTime = Date.now();
        setTimeout(() => {
            if (self._isCurrentState() && !self._iceCompleted) {
                self.logger.warn('ICE collection timed out');
                self.reportIceCompleted(true);
            }
        }, self._rtcSession._iceTimeoutMillis);
        self._rtcSession._createSignalingChannel().connect();
    }
    onSignalingConnected() {
        this._rtcSession._signallingConnectTimestamp = Date.now();
        this._rtcSession._sessionReport.signallingConnectTimeMillis = this._rtcSession._signallingConnectTimestamp - this._startTime;
        this._signalingConnected = true;
        this._rtcSession._onSignalingConnected(this._rtcSession);
        this._rtcSession._sessionReport.signallingConnectionFailure = false;
        this._checkAndTransit();
    }
    onSignalingFailed(e) {
        this._rtcSession._sessionReport.signallingConnectTimeMillis = Date.now() - this._startTime;
        this.logger.error('Failed connecting to signaling server', e);
        this._rtcSession._sessionReport.signallingConnectionFailure = true;
        this.transit(new FailedState(this._rtcSession, RTC_ERRORS.SIGNALLING_CONNECTION_FAILURE));
    }
    _createLocalCandidate(initDict) {
        return new RTCIceCandidate(initDict);
    }
    onIceCandidate(evt) {
        var candidate = evt.candidate;
        this.logger.log('onicecandidate', candidate);
        if (candidate) {
            this._iceCandidates.push(this._createLocalCandidate(candidate));
            if (!this._iceCompleted) {
                this._checkCandidatesSufficient(candidate);
            }

        } else {
            this.reportIceCompleted(false);
        }
    }
    _checkCandidatesSufficient(candidate) {
        //check if we collected both candidates from single media server by checking the same foundation collected twice
        //meaning both RTP and RTCP candidates are collected.
        var candidateAttributesString = candidate.candidate || "";
        var candidateAttributes = candidateAttributesString.split(" ");
        var candidateFoundation = candidateAttributes[0];
        var transportSP = candidateAttributes[1];
        if (candidateFoundation && transportSP) {
            var transportSPsList = this._iceCandidateFoundationsMap[candidateFoundation] || [];
            if (transportSPsList.length > 0 && !transportSPsList.includes(transportSP)) {
                this.reportIceCompleted(false);
            }
            transportSPsList.push(transportSP);
            this._iceCandidateFoundationsMap[candidateFoundation] = transportSPsList;
        }
    }
    reportIceCompleted(isTimeout) {
        this._rtcSession._sessionReport.iceCollectionTimeMillis = Date.now() - this._startTime;
        this._iceCompleted = true;
        this._rtcSession._onIceCollectionComplete(this._rtcSession, isTimeout, this._iceCandidates.length);
        if (this._iceCandidates.length > 0) {
            this._rtcSession._sessionReport.iceCollectionFailure = false;
            this._checkAndTransit();
        } else {
            this.logger.error('No ICE candidate');
            this._rtcSession._sessionReport.iceCollectionFailure = true;
            this.transit(new FailedState(this._rtcSession, RTC_ERRORS.ICE_COLLECTION_TIMEOUT));
        }
    }
    _checkAndTransit() {
        if (this._iceCompleted && this._signalingConnected) {
            this.transit(new InviteAnswerState(this._rtcSession, this._iceCandidates));
        } else if (!this._iceCompleted) {
            this.logger.log('Pending ICE collection');
        } else {//implies _signalingConnected == false
            this.logger.log('Pending signaling connection');
        }
    }
    get name() {
        return "ConnectSignalingAndIceCollectionState";
    }
}
export class InviteAnswerState extends RTCSessionState {
    constructor(rtcSession, iceCandidates) {
        super(rtcSession);
        this._iceCandidates = iceCandidates;
    }
    onEnter() {
        var rtcSession = this._rtcSession;
        rtcSession._onSignalingStarted(rtcSession);
        rtcSession._signalingChannel.invite(rtcSession._localSessionDescription.sdp,
            this._iceCandidates);
    }
    onSignalingAnswered(sdp, candidates) {
        this._rtcSession._sessionReport.userBusyFailure = false;
        this._rtcSession._sessionReport.handshakingFailure = false;
        this.transit(new AcceptState(this._rtcSession, sdp, candidates));
    }
    onSignalingFailed(e) {
        var reason;
        if (e.name == BusyExceptionName) {
            this.logger.error('User Busy, possibly multiple CCP windows open', e);
            this._rtcSession._sessionReport.userBusyFailure = true;
            this._rtcSession._sessionReport.handshakingFailure = true;
            reason = RTC_ERRORS.USER_BUSY;
        } else if (e.name == CallNotFoundExceptionName) {
            this.logger.error('Call not found. One of the participant probably hungup.', e);
            reason = RTC_ERRORS.CALL_NOT_FOUND;
            this._rtcSession._sessionReport.handshakingFailure = true;
        } else {
            this.logger.error('Failed handshaking with signaling server', e);
            this._rtcSession._sessionReport.userBusyFailure = false;
            this._rtcSession._sessionReport.handshakingFailure = true;
            reason = RTC_ERRORS.SIGNALLING_HANDSHAKE_FAILURE;
        }
        this.transit(new FailedState(this._rtcSession, reason));
    }
    get name() {
        return "InviteAnswerState";
    }
}
export class AcceptState extends RTCSessionState {
    constructor(rtcSession, sdp, candidates) {
        super(rtcSession);
        this._sdp = sdp;
        this._candidates = candidates;
    }
    _createSessionDescription(initDict) {
        return new RTCSessionDescription(initDict);
    }
    _createRemoteCandidate(initDict) {
        return new RTCIceCandidate(initDict);
    }
    onEnter() {
        var self = this;
        var rtcSession = self._rtcSession;

        if (!self._sdp) {
            self.logger.error('Invalid remote SDP');
            rtcSession._stopSession();
            rtcSession._sessionReport.invalidRemoteSDPFailure = true;
            self.transit(new FailedState(rtcSession, RTC_ERRORS.INVALID_REMOTE_SDP));
            return;
        } else if (!self._candidates || self._candidates.length < 1) {
            self.logger.error('No remote ICE candidate');
            rtcSession._stopSession();
            rtcSession._sessionReport.noRemoteIceCandidateFailure = true;
            self.transit(new FailedState(rtcSession, RTC_ERRORS.NO_REMOTE_ICE_CANDIDATE));
            return;
        }

        rtcSession._sessionReport.invalidRemoteSDPFailure = false;
        rtcSession._sessionReport.noRemoteIceCandidateFailure = false;
        var setRemoteDescriptionPromise = rtcSession._pc.setRemoteDescription(self._createSessionDescription({
            type: 'answer',
            sdp: self._sdp
        }));
        setRemoteDescriptionPromise.catch(e => {
            self.logger.error('SetRemoteDescription failed', e);
        });
        setRemoteDescriptionPromise.then(() => {
            var remoteCandidatePromises = Promise.all(self._candidates.map(function (candidate) {
                var remoteCandidate = self._createRemoteCandidate(candidate);
                self.logger.info('Adding remote candidate', remoteCandidate);
                return rtcSession._pc.addIceCandidate(remoteCandidate);
            }));
            remoteCandidatePromises.catch(reason => {
                self.logger.warn('Error adding remote candidate', reason);
            });
            return remoteCandidatePromises;
        }).then(() => {
            rtcSession._sessionReport.setRemoteDescriptionFailure = false;
            self._remoteDescriptionSet = true;
            self._checkAndTransit();
        }).catch(() => {
            rtcSession._stopSession();
            rtcSession._sessionReport.setRemoteDescriptionFailure = true;
            self.transit(new FailedState(rtcSession, RTC_ERRORS.SET_REMOTE_DESCRIPTION_FAILURE));
        });
    }
    onSignalingHandshaked() {
        this._rtcSession._sessionReport.handshakingTimeMillis = Date.now() - this._rtcSession._signallingConnectTimestamp;
        this._signalingHandshaked = true;
        this._checkAndTransit();
    }
    _checkAndTransit() {
        if (this._signalingHandshaked && this._remoteDescriptionSet) {
            this.transit(new TalkingState(this._rtcSession));
        } else if (!this._signalingHandshaked) {
            this.logger.log('Pending handshaking');
        } else {//implies _remoteDescriptionSet == false
            this.logger.log('Pending setting remote description');
        }
    }
    get name() {
        return "AcceptState";
    }
}
export class TalkingState extends RTCSessionState {
    onEnter() {
        this._startTime = Date.now();
        this._rtcSession._sessionReport.preTalkingTimeMillis = this._startTime - this._rtcSession._connectTimeStamp;
        this._rtcSession._onSessionConnected(this._rtcSession);
    }
    onSignalingReconnected() {
    }
    onRemoteHungup() {
        this._rtcSession._signalingChannel.hangup();
        this.transit(new DisconnectedState(this._rtcSession));
    }
    hangup() {
        this._rtcSession._signalingChannel.hangup();
        this.transit(new DisconnectedState(this._rtcSession));
    }
    onExit() {
        this._rtcSession._sessionReport.talkingTimeMillis = Date.now() - this._startTime;
        this._rtcSession._detachMedia();
        this._rtcSession._sessionReport.sessionEndTime = new Date();
        this._rtcSession._onSessionCompleted(this._rtcSession);
    }
    get name() {
        return "TalkingState";
    }
}
export class CleanUpState extends RTCSessionState {
    onEnter() {
        this._startTime = Date.now();
        this._rtcSession._stopSession();
    }
    get name() {
        return "CleanUpState";
    }
    hangup() {
        //do nothing, already at the end of lifecycle
    }
    onExit() {
        this._rtcSession._sessionReport.cleanupTimeMillis = Date.now() - this._startTime;
    }
}
export class DisconnectedState extends CleanUpState {
    get name() {
        return "DisconnectedState";
    }
}
export class FailedState extends CleanUpState {
    constructor(rtcSession, failureReason) {
        super(rtcSession);
        this._failureReason = failureReason;
    }
    onEnter() {
        super.onEnter();
        this._rtcSession._sessionReport.sessionEndTime = new Date();
        this._rtcSession._onSessionFailed(this._rtcSession, this._failureReason);
    }
    get name() {
        return "FailedState";
    }
}

export default class RtcSession {
    /**
     * Build an AmazonConnect RTC session.
     * @param {*} signalingUri 
     * @param {*} iceServers Array of ice servers
     * @param {*} contactToken 
     * @param {*} logger An object provides logging functions, such as console
     * @param {*} contactId Must be UUID, uniquely identifies the session.
     */
    constructor(signalingUri, iceServers, contactToken, logger, contactId) {
        if (typeof signalingUri !== 'string' || signalingUri.trim().length === 0) {
            throw new IllegalParameters('signalingUri required');
        }
        if (!iceServers) {
            throw new IllegalParameters('iceServers required');
        }
        if (typeof contactToken !== 'string' || contactToken.trim().length === 0) {
            throw new IllegalParameters('contactToken required');
        }
        if (typeof logger !== 'object') {
            throw new IllegalParameters('logger required');
        }
        if (!contactId) {
            this._callId = uuid();
        } else {
            this._callId = contactId;
        }
        this._sessionReport = new SessionReport();
        this._signalingUri = signalingUri;
        this._iceServers = iceServers;
        this._contactToken = contactToken;
        this._originalLogger = logger;
        this._logger = wrapLogger(this._originalLogger, this._callId, 'SESSION');
        this._iceTimeoutMillis = DEFAULT_ICE_TIMEOUT_MS;
        this._gumTimeoutMillis = DEFAULT_GUM_TIMEOUT_MS;

        this._enableAudio = true;
        this._enableVideo = false;

        this._onGumError =
            this._onGumSuccess =
            this._onLocalStreamAdded =
            this._onSessionFailed =
            this._onSessionInitialized =
            this._onSignalingConnected =
            this._onIceCollectionComplete =
            this._onSignalingStarted =
            this._onSessionConnected =
            this._onRemoteStreamAdded =
            this._onSessionCompleted = () => {
            };
    }
    get sessionReport() {
        return this._sessionReport;
    }

    get callId() {
        return this._callId;
    }
    get mediaStream() {
        return this._userAudioStream;
    }
    /**
     * Callback when gUM succeeds.
     * First param is RtcSession object.
     */
    set onGumSuccess(handler) {
        this._onGumSuccess = handler;
    }
    /**
     * Callback when gUM fails.
     * First param is RtcSession object.
     * Second param is the error.
     */
    set onGumError(handler) {
        this._onGumError = handler;
    }
    /**
     * Callback if failed initializing local resources
     * First param is RtcSession object.
     */
    set onSessionFailed(handler) {
        this._onSessionFailed = handler;
    }
    /**
     * Callback after local user media stream is added to the session.
     * First param is RtcSession object.
     * Second param is media stream
     */
    set onLocalStreamAdded(handler) {
        this._onLocalStreamAdded = handler;
    }
    /**
     * Callback when all local resources are ready. Establishing signaling chanel and ICE collection happens at the same time after this.
     * First param is RtcSession object.
     */
    set onSessionInitialized(handler) {
        this._onSessionInitialized = handler;
    }
    /**
     * Callback when signaling channel is established.
     * RTC session will move forward only if onSignalingConnected and onIceCollectionComplete are both called.
     *
     * First param is RtcSession object.
     */
    set onSignalingConnected(handler) {
        this._onSignalingConnected = handler;
    }
    /**
     * Callback when ICE collection completes either because there is no more candidate or collection timed out.
     * RTC session will move forward only if onSignalingConnected and onIceCollectionComplete are both called.
     *
     * First param is RtcSession object.
     * Second param is boolean, TRUE - ICE collection timed out.
     * Third param is number of candidates collected.
     */
    set onIceCollectionComplete(handler) {
        this._onIceCollectionComplete = handler;
    }
    /**
     * Callback when signaling channel is established and ICE collection completed with at least one candidate.
     * First param is RtcSession object.
     */
    set onSignalingStarted(handler) {
        this._onSignalingStarted = handler;
    }
    /**
     * Callback when the call is established (handshaked and media stream should be flowing)
     * First param is RtcSession object.
     */
    set onSessionConnected(handler) {
        this._onSessionConnected = handler;
    }
    /**
     * Callback after remote media stream is added to the session.
     * This could be called multiple times with the same stream if multiple tracks are included in the same stream.
     *
     * First param is RtcSession object.
     * Second param is media stream track.
     */
    set onRemoteStreamAdded(handler) {
        this._onRemoteStreamAdded = handler;
    }
    /**
     * Callback when the hangup is acked
     * First param is RtcSession object.
     */
    set onSessionCompleted(handler) {
        this._onSessionCompleted = handler;
    }

    set enableAudio(flag) {
        this._enableAudio = flag;
    }
    set enableVideo(flag) {
        this._enableVideo = flag;
    }
    set maxVideoFrameRate(frameRate) {
        this._maxVideoFrameRate = frameRate;
    }
    set minVideoFrameRate(frameRate) {
        this._minVideoFrameRate = frameRate;
    }
    set maxVideoWidth(width) {
        this._maxVideoWidth = width;
    }
    set minVideoWidth(width) {
        this._minVideoWidth = width;
    }
    set maxVideoHeight(height) {
        this._maxVideoHeight = height;
    }
    set minVideoHeight(height) {
        this._minVideoHeight = height;
    }
    /**
     * Optional. RtcSession will grab input device if this is not specified.
     */
    set mediaStream(input) {
        this._userAudioStream = input;
    }
    /**
     * Needed, expect an audio element that can be used to play remote audio stream.
     */
    set remoteAudioElement(element) {
        this._remoteAudioElement = element;
    }
    set remoteVideoElement(element) {
        this._remoteVideoElement = element;
    }
    /**
     * Override the default signaling connect time out.
     */
    set signalingConnectTimeout(ms) {
        this._signalingConnectTimeout = ms;
    }
    /**
     * Override the default ICE collection time limit.
     */
    set iceTimeoutMillis(timeoutMillis) {
        this._iceTimeoutMillis = timeoutMillis;
    }

    /**
     * Override the default GUM timeout time limit.
     */
    set gumTimeoutMillis(timeoutMillis) {
        this._gumTimeoutMillis = timeoutMillis;
    }

    transit(nextState) {
        try {
            this._logger.info((this._state ? this._state.name : 'null') + ' => ' + nextState.name);
            if (this._state && this._state.onExit) {
                this._state.onExit();
            }
        } finally {
            this._state = nextState;
            if (nextState.onEnter) {
                try {
                    nextState.onEnter();
                } catch (e) {
                    this._logger.warn(nextState.name + '#onEnter failed', e);
                    throw e; // eslint-disable-line no-unsafe-finally
                }
            }
        }
    }

    _createSignalingChannel() {
        var signalingChannel = new RtcSignaling(this._callId, this._signalingUri, this._contactToken, this._originalLogger, this._signalingConnectTimeout);
        signalingChannel.onConnected = hitch(this, this._signalingConnected);
        signalingChannel.onAnswered = hitch(this, this._signalingAnswered);
        signalingChannel.onHandshaked = hitch(this, this._signalingHandshaked);
        signalingChannel.onRemoteHungup = hitch(this, this._signalingRemoteHungup);
        signalingChannel.onFailed = hitch(this, this._signalingFailed);
        signalingChannel.onDisconnected = hitch(this, this._signalingDisconnected);

        this._signalingChannel = signalingChannel;

        return signalingChannel;
    }

    _signalingConnected() {
        this._state.onSignalingConnected();
    }
    _signalingAnswered(sdp, candidates) {
        this._state.onSignalingAnswered(sdp, candidates);
    }
    _signalingHandshaked() {
        this._state.onSignalingHandshaked();
    }
    _signalingRemoteHungup() {
        this._state.onRemoteHungup();
    }
    _signalingFailed(e) {
        this._state.onSignalingFailed(e);
    }
    _signalingDisconnected() {
    }
    _createPeerConnection(configuration) {
        return new RTCPeerConnection(configuration);
    }
    connect() {
        var self = this;
        var now = new Date();
        self._sessionReport.sessionStartTime = now;
        self._connectTimeStamp = now.getTime();

        self._pc = self._createPeerConnection({
            iceServers: self._iceServers,
            iceTransportPolicy: 'relay',
            bundlePolicy: 'balanced' //maybe 'max-compat', test stereo sound
        }, {
            optional: [
                {
                    googDscp: true
                }
            ]
        });

        self._pc.ontrack = hitch(self, self._ontrack);
        self._pc.onicecandidate = hitch(self, self._onIceCandidate);

        self.transit(new GrabLocalMediaState(self));
    }
    accept() {
        throw new UnsupportedOperation('accept does not go through signaling channel at this moment');
    }
    hangup() {
        this._state.hangup();
    }
    getRemoteAudioStats() {
        var timestamp = new Date();
        if (this._pc && this._pc.signalingState === 'stable' && this._remoteAudioStream) {
            var audioTracks = this._remoteAudioStream.getAudioTracks();
            return this._pc.getStats(audioTracks[0]).then(function(stats){
                        return extractAudioStatsFromStats(timestamp, stats, 'audio_output');
                    });
        } else {
            return Promise.reject(new IllegalState());
        }
    }
    getUserAudioStats() {
        var stream = this._userAudioStream || this._streamToBeClosed;
        var timestamp = new Date();
        if (this._pc && this._pc.signalingState === 'stable' && stream) {
            var audioTracks = stream.getAudioTracks();
            return this._pc.getStats(audioTracks[0]).then(function(stats){
                        return extractAudioStatsFromStats(timestamp, stats, 'audio_input');
                    });
        } else {
            return Promise.reject(new IllegalState());
        }
    }
    _onIceCandidate(evt) {
        this._state.onIceCandidate(evt);
    }
    /**
     * Attach remote media stream to web element.
     */
    _ontrack(evt) {
        if (evt.streams.length > 1) {
            this._logger.warn('Found more than 1 streams for ' + evt.track.kind + ' track ' + evt.track.id + ' : ' +
                evt.streams.map(stream => stream.id).join(','));
        }
        if (evt.track.kind === 'video' && this._remoteVideoElement) {
            this._remoteVideoElement.srcObject = evt.streams[0];
        } else if (evt.track.kind === 'audio' && this._remoteAudioElement) {
            this._remoteAudioElement.srcObject = evt.streams[0];
            this._remoteAudioStream = evt.streams[0];
        }
        this._onRemoteStreamAdded(this, evt.streams[0]);
    }
    _detachMedia() {
        if (this._remoteVideoElement) {
            this._remoteVideoElement.srcObject = null;
        }
        if (this._remoteAudioElement) {
            this._remoteAudioElement.srcObject = null;
            this._remoteAudioStream = null;
        }
    }
    _stopSession() {
        try {
            if (this._streamToBeClosed) {
                closeStream(this._streamToBeClosed);
                this._streamToBeClosed = null;
            }
        } finally {
            try {
                if (this._pc) {
                    this._pc.close();
                }
            } catch (e) {
                // eat exception
            } finally {
                this._pc = null;
            }
        }
    }

    _buildMediaConstraints() {
        var self = this;
        var mediaConstraints = {};

        if (self._enableAudio) {
            mediaConstraints.audio = true;
        } else {
            mediaConstraints.audio = false;
        }

        if (self._enableVideo) {
            var videoConstraints = {};
            //TODO build video constraints
            if (Object.keys(videoConstraints).length > 0) {
                mediaConstraints.video = videoConstraints;
            } else {
                mediaConstraints.video = true;
            }
            //TODO facingMode : 'user' or 'environment'
        }

        return mediaConstraints;
    }
}
