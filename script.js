// Wait for the DOM to be fully loaded before running the script
document.addEventListener('DOMContentLoaded', () => {
    // Canvas setup
    const canvas = document.getElementById('particleCanvas');
    const ctx = canvas.getContext('2d');

    // Function to resize canvas to fill the window (minus the control bar height)
    function resizeCanvas() {
        const controlsHeight = document.getElementById('ui-controls').offsetHeight;
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight - controlsHeight;
    }

    // Initial resize and listen for window resize events
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Audio Engine Setup
    const masterGain = new Tone.Gain(0.8).toDestination(); // Master volume control, initially 0.8

    // --- Global State & Constants ---
    let particles = [];
    const MAX_PARTICLES = 20;
    let nextParticleId = 0;
    let selectedParticle = null;
    let isPaused = false; // For Pause/Play functionality

    // Particle Class
    class Particle {
        constructor(id, x, y, radius, color) {
            this.id = id;
            this.x = x;
            this.y = y;
            this.vx = 0;
            this.vy = 0;
            this.radius = radius;
            this.color = color || `hsl(${Math.random() * 360}, 70%, 70%)`;

            // Audio properties
            this.naturalFrequency = C1_HZ * Math.pow(2, (MAX_RADIUS - this.radius) / PITCH_SCALING_FACTOR);
            this.baseFrequency = this.quantizeFrequency(this.naturalFrequency, currentScale); // Quantize initially
            this.currentFrequency = this.baseFrequency;

            this.oscillator = new Tone.Oscillator({
                type: 'sine',
                frequency: this.currentFrequency,
                volume: 0 // Default volume 0dB. Max is typically 0dB.
            }).connect(masterGain);

            this.noise = new Tone.Noise('pink');
            this.noiseGain = new Tone.Gain(0);
            this.noise.connect(this.noiseGain);
            this.noiseGain.connect(masterGain);

            this.isMoving = false;
            this.isSelected = false;
            this.wasBent = false;
            this.isCollidingWith = null; // Added from physics step
            this.isSoloed = false;
            this.currentNoiseGainValue = 0; // To store its actual noise gain before being muted by solo
        }

        quantizeFrequency(freq, scaleNotes) {
            // Tone.Frequency can take a frequency value and an array of note names (pitch classes)
            // It finds the closest pitch in any octave that matches one of those pitch classes.
            return Tone.Frequency(freq).quantize(scaleNotes).toFrequency();
        }

        updateBaseFrequency(scaleNotes) {
            this.baseFrequency = this.quantizeFrequency(this.naturalFrequency, scaleNotes);
            // If not currently bent by a collision, update current frequency to new base.
            // The updateAudio loop will handle active bends relative to the new base.
            if (!this.wasBent && !this.isCollidingWith) {
                this.updateFrequency(this.baseFrequency);
            } else {
                // If it is bent, currentFrequency is already being managed by updateAudio.
                // updateAudio will now use the new baseFrequency for its calculations.
                // No direct change to currentFrequency here to avoid conflicting ramps.
            }
        }

        // Method to start audio components for this particle
        startAudio() {
            if (this.oscillator && this.oscillator.state !== 'started') {
                this.oscillator.start();
            }
            if (this.noise && this.noise.state !== 'started') {
                this.noise.start();
                this.noiseGain.gain.value = 0; // Ensure noise starts silent
            }
        }

        // Method to stop audio components
        stopAudio() {
            if (this.oscillator) {
                this.oscillator.stop();
            }
            if (this.noise) {
                this.noise.stop();
            }
        }

        // Method to update frequency (handles ramping)
        updateFrequency(newFreq, rampTime = PITCH_BEND_RAMP_TIME) {
            this.currentFrequency = newFreq;
            if (this.oscillator) {
                // Only ramp if the new frequency is significantly different
                if (Math.abs(this.oscillator.frequency.value - newFreq) > 0.1) {
                    this.oscillator.frequency.rampTo(newFreq, rampTime);
                } else {
                    // If very close, just set it to avoid unnecessary ramp objects
                    this.oscillator.frequency.value = newFreq;
                }
            }
        }

        // Basic draw method for the particle
        draw(ctx) {
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
            ctx.fillStyle = this.color;
            ctx.fill();

            if (this.isSelected) {
                ctx.strokeStyle = 'white';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }
    }

    // Particle Properties Constants (examples, will be tuned)
    const MIN_RADIUS = 10;
    const MAX_RADIUS = 50; // Adjusted for a good visual and pitch range
    const C1_HZ = 32.70; // Frequency of C1
    const PITCH_SCALING_FACTOR = 12; // Tuned for a more noticeable pitch range across radii

    // Audio Behavior Constants (examples, will be tuned)
    const MAX_NOISE_GAIN = 0.03; // Adjusted for more subtlety
    const NOISE_SPEED_FACTOR = 0.005;
    const MIN_SPEED_FOR_NOISE = 0.2; // Adjusted for more definite movement
    const MAX_PITCH_BEND_SEMITONES = 3;
    const PITCH_BEND_RAMP_TIME = 0.05; // 50ms
    const NOISE_GAIN_RAMP_TIME = 0.1; // 100ms for noise gain changes

    // Physics Constants
    const BUMP_FORCE = 5;

    // UI Elements (populated now)
    const scaleSelector = document.getElementById('scaleSelector');
    const playPauseButton = document.getElementById('playPauseButton');
    const muteUnmuteButton = document.getElementById('muteUnmuteButton');
    const soloButton = document.getElementById('soloButton');
    const selectedParticleInfoDisplay = document.getElementById('selectedParticleInfo');

    // Musical Scales Definition
    // Using 'C' as the root for simplicity. Notes include octave numbers.
    // These are relative intervals. We'll need a root note, e.g., C3 or C4.
    // For Tone.Frequency.quantize, it's better to provide a list of notes in the scale over a few octaves.
    const scales = {
        chromatic: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
        major: ['C', 'D', 'E', 'F', 'G', 'A', 'B'],
        naturalMinor: ['C', 'D', 'D#', 'F', 'G', 'G#', 'A#'], // Using D# for Eb, G# for Ab, A# for Bb
        majorPentatonic: ['C', 'D', 'E', 'G', 'A'],
        minorPentatonic: ['C', 'D#', 'F', 'G', 'A#'] // Using D# for Eb, A# for Bb
    };

    let currentScale = scales.chromatic; // Default to chromatic
    const ROOT_NOTE = 'C3'; // Define a root note for scale quantization

    // Helper function to get a full list of notes for a scale across octaves
    function getScaleNotes(scaleName, rootNote, numOctaves = 4) {
        const scaleIntervals = scales[scaleName];
        if (!scaleIntervals) return scales.chromatic.map(n => rootNote.charAt(0) + n.replace( /^\D+/g, '') + (parseInt(rootNote.slice(-1)) + (n.startsWith('C') ? 1: 0) ) ); // Fallback, needs improvement


        let fullScale = [];
        const rootMidi = Tone.Frequency(rootNote).toMidi();
        const baseOctave = parseInt(rootNote.slice(-1));

        for (let i = 0; i < numOctaves; i++) {
            scaleIntervals.forEach(intervalName => {
                // Attempt to form correct note names like C4, D#4, etc.
                // This is simplified; Tone.js's internal logic for intervals would be more robust.
                // For now, we directly use the scale names which Tone.js can often interpret with a root.
                // A more robust way: convert intervals to MIDI relative to root, then back to note names.
                // Example: C, D, E, F, G, A, B for Major. If root is C3: C3, D3, E3, F3, G3, A3, B3, C4, D4...
                // For simplicity with quantize, we can often just pass the scale name array like ['C', 'D', 'E']
                // and Tone.js figures it out with a base frequency.
                // Let's try providing specific note names for Tone.Frequency.quantize
                const noteOctave = baseOctave + i; // this needs to be smarter based on interval
                // This part is tricky. Tone.Frequency(noteName).quantize(scaleArray) works if scaleArray is simple like ['C', 'E', 'G']
                // For now, `scales[scaleName]` contains note names *without octaves*.
                // `Tone.Frequency(freq).quantize(scale)` will use these relative to the freq.
            });
        }
        // The provided `scales` object with note names like 'C', 'D', 'E' is what `Tone.Frequency.quantize` expects
        // when you provide it an array of note names. It will find the closest pitch *within that set of pitch classes*.
        // So, `scales[scaleName]` is already in a good format for `quantize`.
        return scales[scaleName];
    }
    currentScale = getScaleNotes(scaleSelector.value, ROOT_NOTE); // Initialize currentScale properly

    playPauseButton.addEventListener('click', () => {
        isPaused = !isPaused;
        if (isPaused) {
            playPauseButton.textContent = 'Play';
            // Oscillators continue playing their last frequency.
            // Noise gain ramps will complete, then hold.
            console.log('Animation paused');
        } else {
            playPauseButton.textContent = 'Pause';
            console.log('Animation resumed');
            // On resume, the animationLoop will pick up updates.
            // We might need to explicitly call animationLoop once if requestAnimationFrame
            // was not called while paused, but standard rAF loops typically don't need this.
            // The current loop structure calls rAF regardless of isPaused state.
        }
    });

    muteUnmuteButton.addEventListener('click', () => {
        Tone.Destination.mute = !Tone.Destination.mute;
        if (Tone.Destination.mute) {
            muteUnmuteButton.textContent = 'Unmute';
            console.log('Master output muted');
        } else {
            muteUnmuteButton.textContent = 'Mute';
            console.log('Master output unmuted');
        }
    });

    scaleSelector.addEventListener('change', (event) => {
        const selectedScaleName = event.target.value;
        currentScale = getScaleNotes(selectedScaleName, ROOT_NOTE); // getScaleNotes returns the array of note names
        console.log(`Scale changed to: ${selectedScaleName}`);

        particles.forEach(particle => {
            particle.updateBaseFrequency(currentScale);
        });
    });

    // Solo Button - Initial (will be enhanced with particle selection)
    soloButton.disabled = true; // Disabled until a particle is selected
    soloButton.addEventListener('click', () => {
        if (!selectedParticle) {
            console.log('Solo button clicked, but no particle selected.');
            return;
        }

        // Toggle solo state for the selectedParticle
        const currentlySolo = selectedParticle.isSoloed;

        if (currentlySolo) {
            // Unsolo: Restore all particle volumes
            particles.forEach(p => {
                p.oscillator.volume.rampTo(0, 0.1);
                p.noiseGain.gain.rampTo(p.currentNoiseGainValue || 0, 0.1);
                p.isSoloed = false;
            });
            soloButton.textContent = 'Solo';
            soloButton.classList.remove('active');
            console.log(`Particle ${selectedParticle.id} unsoloed.`);
        } else {
            // Solo: Mute others, ensure selected is normal volume
            particles.forEach(p => {
                if (p === selectedParticle) {
                    p.oscillator.volume.rampTo(0, 0.1); // Normal volume (0dB)
                    p.noiseGain.gain.rampTo(p.currentNoiseGainValue || 0, 0.1); // Its current actual noise gain
                    p.isSoloed = true;
                } else {
                    p.oscillator.volume.rampTo(-Infinity, 0.1); // Mute
                    p.noiseGain.gain.rampTo(0, 0.1); // Mute noise
                    p.isSoloed = false;
                }
            });
            soloButton.textContent = 'Unsolo';
            soloButton.classList.add('active');
            console.log(`Particle ${selectedParticle.id} soloed.`);
        }
    });

    function updateSelectedParticleInfo() {
        if (selectedParticle) {
            // Format frequency to 2 decimal places
            const freqDisplay = selectedParticle.currentFrequency.toFixed(2);
            // Format noise gain as percentage or dB. Let's use raw value for now.
            // Reading .value from a non-GainNode or non-Param object will fail.
            // Need to ensure selectedParticle.noiseGain.gain exists.
            const noiseGainObject = selectedParticle.noiseGain || {}; // Handle if noiseGain itself is null/undefined
            const noiseGainParam = noiseGainObject.gain || {}; // Handle if gain is null/undefined
            const noiseDisplay = (noiseGainParam.value !== undefined ? noiseGainParam.value : 0).toFixed(3);

            selectedParticleInfoDisplay.textContent =
                `Selected: Particle #${selectedParticle.id} | Freq: ${freqDisplay} Hz | Noise: ${noiseDisplay}`;
            soloButton.disabled = false;
        } else {
            selectedParticleInfoDisplay.textContent = 'Selected: None';
            soloButton.disabled = true;
            // If solo was active, deactivate it
            const soloActiveParticle = particles.find(p => p.isSoloed);
            if (soloActiveParticle) {
                // Reset all volumes to normal if unselecting a soloed particle
                particles.forEach(p => {
                    p.oscillator.volume.rampTo(0, 0.1);
                    p.noiseGain.gain.rampTo(p.currentNoiseGainValue || 0, 0.1);
                    p.isSoloed = false;
                });
                if (soloButton.classList.contains('active')) {
                    soloButton.textContent = 'Solo';
                    soloButton.classList.remove('active');
                }
            }
        }
    }

    // --- Core Functions (stubs for now, to be implemented in later steps) ---

    canvas.addEventListener('click', (event) => {
        // Resume Tone.js context if it's suspended, as click is a user gesture
        if (Tone.context.state !== 'running') {
            Tone.start().then(() => {
                console.log('AudioContext resumed by canvas click.');
                // If particles hadn't started their audio yet (e.g. if initial body click was missed)
                if (particles.length > 0 && particles[0].oscillator.state !== 'started') {
                    particles.forEach(p => p.startAudio());
                }
            });
        }

        const rect = canvas.getBoundingClientRect();
        const clickX = event.clientX - rect.left;
        const clickY = event.clientY - rect.top;

        let clickedParticle = null;
        // Iterate in reverse to select "topmost" particle if overlapping
        for (let i = particles.length - 1; i >= 0; i--) {
            const particle = particles[i];
            const dx = clickX - particle.x;
            const dy = clickY - particle.y;
            const distanceSquared = dx * dx + dy * dy;

            if (distanceSquared < particle.radius * particle.radius) {
                clickedParticle = particle;
                break; // Select the first one found (topmost if drawn in order)
            }
        }

        if (selectedParticle && selectedParticle !== clickedParticle) {
            selectedParticle.isSelected = false; // Deselect previous
        }

        if (clickedParticle) {
            selectedParticle = clickedParticle;
            selectedParticle.isSelected = true;

            // Apply impulse
            const angle = Math.random() * Math.PI * 2;
            const forceMagnitude = BUMP_FORCE; // BUMP_FORCE is already defined
            selectedParticle.vx += Math.cos(angle) * forceMagnitude;
            selectedParticle.vy += Math.sin(angle) * forceMagnitude;
            selectedParticle.isMoving = true; // Set isMoving flag

            console.log(`Particle ${selectedParticle.id} clicked and selected. Impulse applied.`);
        } else {
            // Clicked on empty space
            if (selectedParticle) {
                selectedParticle.isSelected = false;
            }
            selectedParticle = null;
            console.log('Canvas clicked (empty space), selection cleared.');
        }

        updateSelectedParticleInfo(); // Update UI display and Solo button state
    });

    function initializeParticles(num) {
        particles.forEach(p => p.stopAudio()); // Stop any existing particles' audio
        particles = []; // Clear existing particles
        nextParticleId = 0; // Reset ID counter

        const numToCreate = Math.min(num, MAX_PARTICLES);
        console.log(`Initializing ${numToCreate} particles...`);

        for (let i = 0; i < numToCreate; i++) {
            const radius = MIN_RADIUS + Math.random() * (MAX_RADIUS - MIN_RADIUS);
            // Ensure particles are initialized within canvas bounds, away from edges
            const x = radius + Math.random() * (canvas.width - radius * 2);
            const y = radius + Math.random() * (canvas.height - radius * 2);

            const particle = new Particle(nextParticleId++, x, y, radius);
            particles.push(particle);
            // particle.startAudio(); // Audio will be started globally or on interaction
        }
        console.log(`${particles.length} particles created.`);
    }

    function drawParticles() {
        // Loop through all particles and draw them
        for (const particle of particles) {
            particle.draw(ctx); // Call the draw method of each particle
        }
    }

    function updatePhysics() {
        if (isPaused) return; // Should already be handled by animationLoop, but good for safety

        for (let i = 0; i < particles.length; i++) {
            const particle = particles[i];

            // 1. Particle Movement
            // Only update if particle has non-zero velocity.
            // The isMoving flag can be used to initiate movement via click.
            if (particle.vx !== 0 || particle.vy !== 0) {
                particle.x += particle.vx;
                particle.y += particle.vy;
                // Simple friction/drag can be added here if desired later:
                // particle.vx *= 0.99;
                // particle.vy *= 0.99;
            }


            // 2. Screen Wrap (Asteroids Style)
            if (particle.x - particle.radius > canvas.width) {
                particle.x = -particle.radius;
            } else if (particle.x + particle.radius < 0) {
                particle.x = canvas.width + particle.radius;
            }
            if (particle.y - particle.radius > canvas.height) {
                particle.y = -particle.radius;
            } else if (particle.y + particle.radius < 0) {
                particle.y = canvas.height + particle.radius;
            }

            // 3. Collision Detection (Part 1: Detection)
            // Store collision state on the particle for audio processing later
            particle.isCollidingWith = null; // Reset collision state for this frame

            for (let j = i + 1; j < particles.length; j++) {
                const otherParticle = particles[j];
                const dx = otherParticle.x - particle.x;
                const dy = otherParticle.y - particle.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                const minDistance = particle.radius + otherParticle.radius;

                if (distance < minDistance) {
                    // Collision detected!
                    // For pitch bending, we need to know which is smaller/larger.
                    // The audio behavior step will handle the reaction.
                    // For now, let's just mark them. We'll refine this in the audio step.

                    // A particle can be in multiple collisions. The spec says:
                    // "If a small particle is involved in multiple collisions, the pitch bend
                    // is determined by the collision with the largest of the other colliding particles."
                    // So, we need to track the largest particle it's colliding with if it's the smaller one.

                    let smaller, larger;
                    if (particle.radius < otherParticle.radius) {
                        smaller = particle;
                        larger = otherParticle;
                    } else if (otherParticle.radius < particle.radius) {
                        smaller = otherParticle;
                        larger = particle;
                    } else {
                        // Equal radii, use ID as tie-breaker (lower ID is 'larger' as per spec)
                        if (particle.id < otherParticle.id) {
                            larger = particle; // Arbitrarily, particle is 'larger'
                            smaller = otherParticle;
                        } else {
                            larger = otherParticle;
                            smaller = particle;
                        }
                    }

                    // If 'smaller' is already colliding, check if 'larger' is bigger than its current collision partner
                    if (!smaller.isCollidingWith || larger.radius > smaller.isCollidingWith.radius) {
                        smaller.isCollidingWith = larger; // Mark the smaller particle with its largest collision partner
                    }
                    // Symmetrically, if 'larger' is the smaller one in another collision (can't happen with this logic, but good to keep in mind)
                    // This simple assignment means a particle is only marked if it's the smaller one in a collision.
                    // We might need a more robust way to store all collision pairs if complex interactions were needed,
                    // but for the specified pitch bending, this should be sufficient.
                }
            }
        }
    }

    function updateAudio() {
        if (isPaused) return; // Audio modulation should also pause

        particles.forEach(particle => {
            // 1. Movement-Based Noise
            const speed = Math.sqrt(particle.vx * particle.vx + particle.vy * particle.vy);
            let noiseGainValue = 0;
            if (speed > MIN_SPEED_FOR_NOISE) {
                noiseGainValue = Math.min(MAX_NOISE_GAIN, speed * NOISE_SPEED_FACTOR);
            }
            particle.currentNoiseGainValue = noiseGainValue; // Store this value

            // Ensure noiseGain and its gain property exist before trying to ramp
            if (particle.noiseGain && particle.noiseGain.gain) {
                // Only ramp if not soloed by another particle, or if this is the soloed one
                const isActuallySoloedByOther = particles.some(p => p.isSoloed && p !== particle);
                if (!isActuallySoloedByOther || particle.isSoloed) {
                    if (Math.abs(particle.noiseGain.gain.value - noiseGainValue) > 0.001) {
                        particle.noiseGain.gain.rampTo(noiseGainValue, NOISE_GAIN_RAMP_TIME);
                    }
                }
            }

            // 2. Collision-Based Pitch Bending
            // The 'isCollidingWith' property now stores the LARGER particle if 'particle' is the SMALLER one.
            const largeCollider = particle.isCollidingWith;

            if (largeCollider) {
                // This particle is the smaller one in a collision with 'largeCollider'
                const P_small = particle;
                const P_large = largeCollider;

                const bendRatio = Math.max(0, (P_large.radius - P_small.radius) / P_large.radius); // Ensure ratio is not negative
                const pitchBendSemitones = bendRatio * MAX_PITCH_BEND_SEMITONES;
                const targetFrequency = P_small.baseFrequency * Math.pow(2, -pitchBendSemitones / 12);

                if (Math.abs(P_small.currentFrequency - targetFrequency) > 0.1) { // Avoid tiny ramps
                    P_small.updateFrequency(targetFrequency, PITCH_BEND_RAMP_TIME);
                }
                P_small.wasBent = true; // Flag that it's currently bent by collision

            } else {
                // This particle is not the smaller one in any collision OR not colliding at all.
                // If it was previously bent by a collision, ramp it back to base frequency.
                if (particle.wasBent || Math.abs(particle.currentFrequency - particle.baseFrequency) > 0.1) {
                    particle.updateFrequency(particle.baseFrequency, PITCH_BEND_RAMP_TIME);
                    particle.wasBent = false;
                }
            }
        });
    }

    function animationLoop() {
        // requestAnimationFrame should be the first thing for smoother animations
        requestAnimationFrame(animationLoop);

        if (!isPaused) {
            // Clear canvas: Using rgba for a slight trail effect, or use clearRect for no trail
            // ctx.fillStyle = 'rgba(0, 0, 0, 0.1)'; // Example: For a trail effect
            // ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.clearRect(0, 0, canvas.width, canvas.height); // Clear canvas completely

            updatePhysics(); // Stub, will be implemented in Step 6
            updateAudio();   // Stub, will be implemented in Step 7
            drawParticles(); // Now calls the implemented function
        }
        // If paused, we still need to call requestAnimationFrame to resume, but do no updates.
    }

    // --- Initialization ---
    // Start Tone.js context on user interaction (good practice)
    document.body.addEventListener('click', async () => {
        if (Tone.context.state !== 'running') {
            await Tone.start();
            console.log('AudioContext started');
            // Start audio for all initialized particles once context is running
            particles.forEach(p => p.startAudio());
            console.log('Initial particles audio started.');
        }
    }, { once: true });

    initializeParticles(10); // Initialize with 10 particles by default
    animationLoop(); // Start the animation loop

    console.log('PartiSynth initialized');
    updateSelectedParticleInfo(); // Initialize the display
    console.log('PartiSynth UI initial setup complete.');
}); // End of DOMContentLoaded
