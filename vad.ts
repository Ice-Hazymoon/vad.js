interface VADOptions {
    fftSize?: number;
    bufferLen?: number;
    voice_stop?: () => void;
    voice_start?: () => void;
    smoothingTimeConstant?: number;
    energy_offset?: number;
    energy_threshold_ratio_pos?: number;
    energy_threshold_ratio_neg?: number;
    energy_integration?: number;
    filter?: { f: number; v: number }[];
    source: AudioNode | null;
    context?: AudioContext | null;
    voice_stop_delay?: number;
    voice_timeout?: number;
    voice_timeout_callback?: () => void;
}

class VAD {
    private options: VADOptions;
    private hertzPerBin: number;
    private iterationFrequency: number;
    private iterationPeriod: number;
    private filter: number[] = [];
    private ready = false;
    private vadState = false;
    private energy = 0;
    private energy_offset: number;
    private energy_threshold_pos: number;
    private energy_threshold_neg: number;
    private voiceTrend = 0;
    private readonly voiceTrendMax = 10;
    private readonly voiceTrendMin = -10;
    private readonly voiceTrendStart = 5;
    private readonly voiceTrendEnd = -5;
    private analyser: AnalyserNode;
    private floatFrequencyData: Float32Array;
    private floatFrequencyDataLinear: Float32Array;
    private scriptProcessorNode: ScriptProcessorNode;
    private voiceStopTimeout: any = null;
    private voice_timeout: number | null = null;
    private voice_timeout_callback: (() => void) | null = null;
    private voice_timeoutId: any = null;

    constructor(options: VADOptions) {
        const defaultOptions: VADOptions = {
            fftSize: 512,
            bufferLen: 512,
            voice_stop: () => {},
            voice_start: () => {},
            smoothingTimeConstant: 0.99,
            energy_offset: 1e-8,
            energy_threshold_ratio_pos: 2,
            energy_threshold_ratio_neg: 0.5,
            energy_integration: 1,
            filter: [
                { f: 200, v: 0 },
                { f: 2000, v: 1 },
            ],
            source: null,
            context: null,
            voice_stop_delay: 1000,
        };

        this.options = { ...defaultOptions, ...options };

        if (!this.options.source) throw new Error('The options must specify a MediaStreamAudioSourceNode.');
        this.options.context = this.options.source.context as AudioContext;

        this.hertzPerBin = this.options.context.sampleRate / this.options.fftSize!;
        this.iterationFrequency = this.options.context.sampleRate / this.options.bufferLen!;
        this.iterationPeriod = 1 / this.iterationFrequency;

        this.setFilter(this.options.filter!);

        this.energy_offset = this.options.energy_offset!;
        this.energy_threshold_pos = this.energy_offset * this.options.energy_threshold_ratio_pos!;
        this.energy_threshold_neg = this.energy_offset * this.options.energy_threshold_ratio_neg!;

        this.analyser = this.options.context.createAnalyser();
        this.analyser.smoothingTimeConstant = this.options.smoothingTimeConstant!;
        this.analyser.fftSize = this.options.fftSize!;

        this.floatFrequencyData = new Float32Array(this.analyser.frequencyBinCount);
        this.floatFrequencyDataLinear = new Float32Array(this.floatFrequencyData.length);

        this.options.source.connect(this.analyser);

        this.scriptProcessorNode = this.options.context.createScriptProcessor(this.options.bufferLen!, 1, 1);
        this.scriptProcessorNode.connect(this.options.context.destination);

        this.scriptProcessorNode.onaudioprocess = event => {
            this.analyser.getFloatFrequencyData(this.floatFrequencyData);
            this.update();
            this.monitor();
        };

        this.options.source.connect(this.scriptProcessorNode);

        if (options.voice_timeout && options.voice_timeout_callback) {
            this.voice_timeout = options.voice_timeout;
            this.voice_timeout_callback = options.voice_timeout_callback;
        }
    }

    private setFilter(shape: { f: number; v: number }[]): void {
        for (let i = 0, iLen = this.options.fftSize! / 2; i < iLen; i++) {
            this.filter[i] = 0;
            for (const shapeItem of shape) {
                if (i * this.hertzPerBin < shapeItem.f) {
                    this.filter[i] = shapeItem.v;
                    break;
                }
            }
        }
    }

    private update(): void {
        const fft = this.floatFrequencyData;
        for (let i = 0, iLen = fft.length; i < iLen; i++) {
            this.floatFrequencyDataLinear[i] = Math.pow(10, fft[i] / 10);
        }
        this.ready = false;
    }

    private getEnergy(): number {
        if (this.ready) {
            return this.energy;
        }
        let energy = 0;
        const fft = this.floatFrequencyDataLinear;
        for (let i = 0, iLen = fft.length; i < iLen; i++) {
            energy += this.filter[i] * fft[i] * fft[i];
        }
        this.energy = energy;
        this.ready = true;
        return energy;
    }

    private monitor(): number {
        const energy = this.getEnergy();
        const signal = energy - this.energy_offset;

        if (signal > this.energy_threshold_pos) {
            this.voiceTrend = this.voiceTrend + 1 > this.voiceTrendMax ? this.voiceTrendMax : this.voiceTrend + 1;
        } else if (signal < -this.energy_threshold_neg) {
            this.voiceTrend = this.voiceTrend - 1 < this.voiceTrendMin ? this.voiceTrendMin : this.voiceTrend - 1;
        } else {
            if (this.voiceTrend > 0) {
                this.voiceTrend--;
            } else if (this.voiceTrend < 0) {
                this.voiceTrend++;
            }
        }

        let start = false,
            end = false;
        if (this.voiceTrend > this.voiceTrendStart) {
            start = true;
        } else if (this.voiceTrend < this.voiceTrendEnd) {
            end = true;
        }

        const integration = signal * this.iterationPeriod * this.options.energy_integration!;
        if (integration > 0 || !end) {
            this.energy_offset += integration;
        } else {
            this.energy_offset += integration * 10;
        }
        this.energy_offset = this.energy_offset < 0 ? 0 : this.energy_offset;
        this.energy_threshold_pos = this.energy_offset * this.options.energy_threshold_ratio_pos!;
        this.energy_threshold_neg = this.energy_offset * this.options.energy_threshold_ratio_neg!;

        if (start && !this.vadState) {
            this.vadState = true;
            this.options.voice_start!();
            if (this.voiceStopTimeout) {
                clearTimeout(this.voiceStopTimeout);
            }
        }
        if (end && this.vadState) {
            this.vadState = false;
            if (this.options.voice_stop_delay) {
                this.delayedVoiceStop();
            } else {
                this.options.voice_stop!();
            }
        }

        if (start) {
            clearTimeout(this.voice_timeoutId);
        }

        if (end && !this.voice_timeoutId) {
            this.resetVoice_timeout();
        }

        return signal;
    }

    private delayedVoiceStop(): void {
        if (this.voiceStopTimeout) {
            clearTimeout(this.voiceStopTimeout);
        }

        this.voiceStopTimeout = setTimeout(() => {
            if (!this.vadState) {
                this.options.voice_stop!();
            }
        }, this.options.voice_stop_delay!);
    }

    private resetVoice_timeout(): void {
        if (this.voice_timeout && this.voice_timeout_callback) {
            clearTimeout(this.voice_timeoutId);
            this.voice_timeoutId = setTimeout(() => {
                this.voice_timeout_callback!();
            }, this.voice_timeout);
        }
    }
}

export default VAD;
