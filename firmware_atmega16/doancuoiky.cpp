#define F_CPU 16000000UL
#include <avr/io.h>
#include <avr/interrupt.h>
#include <string.h>
#include <stdlib.h>
#include <util/delay.h>

#define BAUDRATE 115200
#define MYUBRR ((F_CPU / (8UL * BAUDRATE)) - 1)

// --- ??NH NGH?A CH?N M?CH ---
#define MOTOR_PORT PORTA
#define MOTOR_DDR DDRA
#define RELAY_PORT_V PORTC

// --- C?U H?NH ROBOT ---
#define STEPS_PER_DEGREE 17.778f
#define HOMING_ANGLE_DEG 2.09f

// FIX 1: T?ng buffer t? 200 ? 256 (corner blending th?m waypoints, chu?i UART d?i h?n)
volatile char rx_buffer[256];
volatile uint8_t rx_index = 0;
volatile uint8_t command_ready = 0;
volatile uint8_t rx_busy = 0;
volatile uint32_t ms_ticks = 0;
volatile uint8_t emergency_flag = 0;
volatile uint8_t uart_overflow_flag = 0;
volatile uint8_t queue_full_flag = 0;
struct Axis {
    long current_pos;
} motors[3]; // 0: PA6, 1: PA2, 2: PA4

// --- H?NG ??I CHUY?N ??NG ---
#define MAX_QUEUE 6
#define SCURVE_RATIO 0.35f
#define MIN_RAMP_STEPS 6L
typedef struct {
    long target[3];
    long max_steps;
    long steps_i[3];
    uint8_t dir_mask_set;
    uint8_t dir_mask_clear;
    float min_delay;
    uint8_t profile_type;
} PathSegment;

volatile PathSegment path_queue[MAX_QUEUE];
volatile uint8_t q_head = 0;
volatile uint8_t q_tail = 0;
volatile uint8_t is_moving = 0;

// Bi?n ISR stepper
volatile uint8_t  timer_mode      = 0;
volatile long     current_step_s  = 0;
volatile long     count_i[3];
volatile long     accel_steps_s;
volatile long     decel_start_s;
volatile long     decel_steps_s;
volatile float    current_delay_s;
volatile float    min_delay_s;
volatile float    accel_start_delay_s;
volatile float    slow_delay_s;

// FIX 2: K? th?a t?c ?? gi?a c?c segment
// L?u delay cu?i c?a segment v?a k?t th?c; = 0 khi queue r?ng.
volatile float    last_seg_delay  = 0.0f;

volatile uint16_t homing_backoff_count = 0;
volatile uint16_t servo_pwm_count = 0;
volatile uint16_t servo_target_width = 150;
volatile uint8_t servo_enabled = 0;

#define SERVO_RELEASE_MIN_MS 300UL
#define SERVO_PULSE_MIN_10US 50
#define SERVO_PULSE_MAX_10US 242
#define SERVO_ANGLE_OFFSET_DEG 0.0f
#define EMERGENCY_DEBOUNCE_MS 25
#define EMERGENCY_ACTIVE_LOW 1


// --- UART ---
void uart_init(unsigned int ubrr) {
    UBRRH = (unsigned char)(ubrr >> 8);
    UBRRL = (unsigned char)ubrr;
    UCSRA |= (1 << U2X);
    UCSRB = (1 << RXCIE) | (1 << RXEN) | (1 << TXEN);
    UCSRC = (1 << URSEL) | (1 << UCSZ1) | (1 << UCSZ0);
}
void uart_putchar(char c) { while (!(UCSRA & (1 << UDRE))); UDR = c; }
void uart_puts(const char *s) { while (*s) { uart_putchar(*s++); } }
char* next_token(char **cursor) {
    if (*cursor == NULL) return NULL;

    char *start = *cursor;
    char *sep = strchr(start, '|');

    if (sep) {
        *sep = '\0';
        *cursor = sep + 1;
    } else {
        *cursor = NULL;
    }

    return start;
}

char* trim_token(char *token) {
    while ((unsigned char)*token <= ' ' && *token != '\0') token++;

    char *end = token + strlen(token);
    while (end > token && (unsigned char)end[-1] <= ' ') {
        end--;
    }
    *end = '\0';

    return token;
}

ISR(USART_RXC_vect) {
    char c = UDR;

    if (rx_busy || command_ready) {
        return;
    }

    if (c == '\n' || c == '\r') {
        if (rx_index > 0) {
            rx_buffer[rx_index] = '\0';
            if (rx_buffer[0] == 'C') { uart_puts("A\n"); rx_index = 0; return; }
            if (rx_buffer[0] == 'W') { if (!is_moving) uart_puts("R\n"); rx_index = 0; return; }
            command_ready = 1;
        }
        rx_index = 0;
    // FIX 1: Gi?i h?n ghi theo k?ch th??c buffer m?i
    } else if (rx_index < 255) {
        rx_buffer[rx_index++] = c;
    } else {
        uart_overflow_flag = 1;
    }
}

// --- NG?T KH?N C?P ---
ISR(INT0_vect) {
    _delay_ms(EMERGENCY_DEBOUNCE_MS);

#if EMERGENCY_ACTIVE_LOW
    if (PIND & (1 << PD2)) {
        GIFR |= (1 << INTF0);
        return;
    }
#else
    if (!(PIND & (1 << PD2))) {
        GIFR |= (1 << INTF0);
        return;
    }
#endif

    if (emergency_flag) {
        GIFR |= (1 << INTF0);
        return;
    }

	TIMSK &= ~(1 << OCIE1A);
    MOTOR_PORT &= ~((1<<PA2)|(1<<PA4)|(1<<PA6));
    RELAY_PORT_V &= ~(1 << PC2);
    timer_mode = 0; is_moving = 0; q_head = q_tail = 0;
    last_seg_delay = 0.0f; // Reset t?c ?? k? th?a khi d?ng kh?n c?p
    uart_puts("STATUS|EMERGENCY_STOP\n");
	emergency_flag = 1;
}

// --- SERVO (TIMER 0) ---
void timer0_init_servo() {
    TCCR0 = (1 << WGM01) | (1 << CS01);
    OCR0 = 19;
    TIMSK |= (1 << OCIE0);
    DDRB |= (1 << PB3);
}
ISR(TIMER0_COMP_vect) {
    servo_pwm_count++;
    if (servo_pwm_count >= 2000) servo_pwm_count = 0;
    if (servo_enabled && servo_pwm_count < servo_target_width) PORTB |= (1 << PB3);
    else PORTB &= ~(1 << PB3);
    static uint8_t count_to_1ms = 0;
    if (++count_to_1ms >= 100) {
        ms_ticks++;
        count_to_1ms = 0;
    }
}
void set_servo_angle_fine(float angle) {
    angle += SERVO_ANGLE_OFFSET_DEG;
    if (angle < 0) angle = 0;
    if (angle > 180) angle = 180;
    uint16_t temp_width = SERVO_PULSE_MIN_10US +
        (uint16_t)((angle * (SERVO_PULSE_MAX_10US - SERVO_PULSE_MIN_10US)) / 180.0f);
    cli();
    servo_target_width = temp_width;
    servo_pwm_count = 0;
    servo_enabled = 1;
    sei();
}
void release_servo_signal() {
    cli();
    servo_enabled = 0;
    PORTB &= ~(1 << PB3);
    sei();
}
void delay_ms_safe(uint32_t ms) {
    uint32_t start = ms_ticks;
    while ((ms_ticks - start) < ms);
}


// --- STEPPER (TIMER 1) ---
void timer1_init() {
    TCCR1A = 0;
    TCCR1B = (1 << WGM12) | (1 << CS11);
    OCR1A = 10000;
    TIMSK &= ~(1 << OCIE1A);
}


float smoothstep01(float x) {
    if (x < 0.0f) return 0.0f;
    if (x > 1.0f) return 1.0f;
    return x * x * (3.0f - 2.0f * x);
}

long ramp_steps_for(long max_steps) {
    long ramp = (long)((float)max_steps * SCURVE_RATIO);

    if (ramp < MIN_RAMP_STEPS) ramp = MIN_RAMP_STEPS;
    if (ramp > max_steps / 2) ramp = max_steps / 2;
    if (ramp < 1) ramp = 1;

    return ramp;
}

void load_segment_to_isr() {
    if (q_head == q_tail) {
        timer_mode = 0;
        is_moving  = 0;
        TIMSK &= ~(1 << OCIE1A);
        last_seg_delay = 0.0f; // Queue r?ng: reset t?c ?? k? th?a
        return;
    }

    PathSegment *seg = (PathSegment*)&path_queue[q_head];
    MOTOR_PORT |= seg->dir_mask_set;
    MOTOR_PORT &= ~(seg->dir_mask_clear);

    min_delay_s    = seg->min_delay;
    current_step_s = 0;
    count_i[0] = count_i[1] = count_i[2] = 0;

    // Ch?n delay kh?i ??u: k? th?a n?u h?p l?, kh?ng th? d?ng max (ch?m)
    float max_start = min_delay_s * 2.0f;
    float start_delay = (last_seg_delay > min_delay_s && last_seg_delay <= max_start)
                        ? last_seg_delay
                        : max_start;
    slow_delay_s = max_start;
    accel_start_delay_s = start_delay;

    if (seg->profile_type == 0) {
        // Ch? t?ng t?c (segment ??u c?a chu?i): b?t ??u t? t?c ?? k? th?a
        accel_steps_s  = ramp_steps_for(seg->max_steps);
        decel_start_s  = seg->max_steps * 2;   // Kh?ng gi?m t?c
        decel_steps_s  = 0;
        current_delay_s = start_delay;
    } else if (seg->profile_type == 1) {
        // T?c ?? kh?ng ??i (segment gi?a): k? th?a v? ch?y th?ng t?c ?? max
        accel_steps_s  = 0;
        decel_start_s  = seg->max_steps * 2;
        decel_steps_s  = 0;
        current_delay_s = min_delay_s;          // ?? ? t?c ?? ??nh t? segment tr??c
    } else if (seg->profile_type == 2) {
        // Ch? gi?m t?c (segment cu?i): b?t ??u t? t?c ?? ??nh
        accel_steps_s  = 0;
        decel_start_s  = 0;                     // B?t ??u gi?m t?c ngay
        decel_steps_s  = seg->max_steps;
        current_delay_s = min_delay_s;
    } else {
        // T?ng r?i gi?m (segment duy nh?t): b?t ??u t? t?c ?? k? th?a
        accel_steps_s  = ramp_steps_for(seg->max_steps);
        decel_steps_s  = ramp_steps_for(seg->max_steps);
        decel_start_s  = seg->max_steps - decel_steps_s;
        current_delay_s = start_delay;
    }

    OCR1A = (uint16_t)current_delay_s;
}


ISR(TIMER1_COMPA_vect) {
    if (timer_mode == 1) {
        PathSegment *seg = (PathSegment*)&path_queue[q_head];

        // --- S-curve speed profile ---
        if (accel_steps_s > 0 && current_step_s < accel_steps_s) {
            float denom = (accel_steps_s > 1) ? (float)(accel_steps_s - 1) : 1.0f;
            float u = (float)current_step_s / denom;
            float s = smoothstep01(u);
            current_delay_s = accel_start_delay_s - (accel_start_delay_s - min_delay_s) * s;
        } else if (decel_steps_s > 0 && current_step_s >= decel_start_s) {
            float denom = (decel_steps_s > 1) ? (float)(decel_steps_s - 1) : 1.0f;
            float u = (float)(current_step_s - decel_start_s) / denom;
            float s = smoothstep01(u);
            current_delay_s = min_delay_s + (slow_delay_s - min_delay_s) * s;
        } else {
            current_delay_s = min_delay_s;
        }

        // Clamp tuy?t ??i: b?o v? driver stepper kh?i xung qu? nhanh
        if (current_delay_s < 100.0f) current_delay_s = 100.0f;
        if (current_delay_s > slow_delay_s) current_delay_s = slow_delay_s;
        OCR1A = (uint16_t)current_delay_s;

        // --- T?o xung b??c (Bresenham) ---
        for (int i = 0; i < 3; i++) {
            count_i[i] += seg->steps_i[i];
            if (count_i[i] >= seg->max_steps) {
                if      (i == 0) MOTOR_PORT |= (1 << PA6);
                else if (i == 1) MOTOR_PORT |= (1 << PA2);
                else             MOTOR_PORT |= (1 << PA4);
                count_i[i] -= seg->max_steps;
            }
        }
        _delay_us(2);
        MOTOR_PORT &= ~((1<<PA2)|(1<<PA4)|(1<<PA6));

        // --- K?t th?c segment ---
        if (++current_step_s >= seg->max_steps) {
            // L?u t?c ?? t?i b??c cu?i ?? segment ti?p theo k? th?a
            last_seg_delay = current_delay_s;

            for (int i = 0; i < 3; i++) motors[i].current_pos = seg->target[i];
            q_head++;
            load_segment_to_isr();
        }
    }
    else if (timer_mode == 2) { // HOMING LêN (nhanh)
        uint8_t pins = PINB; uint8_t all_hit = 1;
        if (pins & (1<<PB4)) { MOTOR_PORT |= (1<<PA6); all_hit = 0; }
        if (pins & (1<<PB0)) { MOTOR_PORT |= (1<<PA2); all_hit = 0; }
        if (pins & (1<<PB1)) { MOTOR_PORT |= (1<<PA4); all_hit = 0; }
        _delay_us(1000);
        MOTOR_PORT &= ~((1<<PA2)|(1<<PA4)|(1<<PA6));
        OCR1A = 1200;
        if (all_hit) timer_mode = 3;
    }
    else if (timer_mode == 3) { // L?I L?I
        MOTOR_PORT &= ~((1 << PA3) | (1 << PA5) | (1 << PA7));
        MOTOR_PORT |= (1<<PA2) | (1<<PA4) | (1<<PA6);
        _delay_us(2);
        MOTOR_PORT &= ~((1<<PA2)|(1<<PA4)|(1<<PA6));
        OCR1A = 2000;
        if (++homing_backoff_count >= 400) {
            MOTOR_PORT |= (1 << PA3) | (1 << PA5) | (1 << PA7);
            timer_mode = 4;
        }
    }
    else if (timer_mode == 4) { // L?N CH?M (t?m home ch?nh x?c)
        uint8_t pins = PINB; uint8_t all_hit = 1;
        if (pins & (1<<PB4)) { MOTOR_PORT |= (1<<PA6); all_hit = 0; }
        if (pins & (1<<PB0)) { MOTOR_PORT |= (1<<PA2); all_hit = 0; }
        if (pins & (1<<PB1)) { MOTOR_PORT |= (1<<PA4); all_hit = 0; }
        _delay_us(2);
        MOTOR_PORT &= ~((1<<PA2)|(1<<PA4)|(1<<PA6));
        OCR1A = 4000;
        if (all_hit) { homing_backoff_count = 0; timer_mode = 5; }
    }
    else if (timer_mode == 5) { // ?I XU?NG 34.85? R?I D?NG
        MOTOR_PORT &= ~((1 << PA3) | (1 << PA5) | (1 << PA7));
        MOTOR_PORT |= (1<<PA2) | (1<<PA4) | (1<<PA6);
        _delay_us(2);
        MOTOR_PORT &= ~((1<<PA2)|(1<<PA4)|(1<<PA6));
        OCR1A = 4000;
        // 34.85? * 17.778 steps/? ? 620 b??c
        if (++homing_backoff_count >= 620) {
            timer_mode = 0;
            TIMSK &= ~(1 << OCIE1A);
            homing_backoff_count = 0;
            last_seg_delay = 0.0f; // Sau homing lu?n b?t ??u t? t?c ?? th?p
        }
    }
}

void enqueue_motion(float t1, float t2, float t3, float T_ms) {
    if (q_tail >= MAX_QUEUE) {
        queue_full_flag = 1;
        return;
    }
    PathSegment *seg = (PathSegment*)&path_queue[q_tail];
    seg->target[0] = (long)(t1 * STEPS_PER_DEGREE);
    seg->target[1] = (long)(t2 * STEPS_PER_DEGREE);
    seg->target[2] = (long)(t3 * STEPS_PER_DEGREE);

    seg->max_steps      = 0;
    seg->dir_mask_set   = 0;
    seg->dir_mask_clear = 0;

    long start_pos[3];
    for (int i = 0; i < 3; i++)
        start_pos[i] = (q_tail == 0) ? motors[i].current_pos
                                     : path_queue[q_tail - 1].target[i];

    for (int i = 0; i < 3; i++) {
        long dist = seg->target[i] - start_pos[i];
        seg->steps_i[i] = labs(dist);
        if (seg->steps_i[i] > seg->max_steps) seg->max_steps = seg->steps_i[i];

        uint8_t dir_pin = (i == 0) ? PA7 : (i == 1 ? PA3 : PA5);
        if (dist <= 0) seg->dir_mask_set   |= (1 << dir_pin);
        else           seg->dir_mask_clear |= (1 << dir_pin);
    }

    if (seg->max_steps == 0) return;

    seg->min_delay = (T_ms * 1000.0f) / (float)seg->max_steps;

    q_tail++;
}

void wait_for_motion_finish() {
    if (q_tail > 0 && !is_moving) {
        for (uint8_t i = 0; i < q_tail; i++) {
            if      (q_tail == 1)        path_queue[i].profile_type = 3; // Trap
            else if (i == 0)             path_queue[i].profile_type = 0; // Accel only
            else if (i == q_tail - 1)    path_queue[i].profile_type = 2; // Decel only
            else                         path_queue[i].profile_type = 1; // Constant
        }
        is_moving = 1; q_head = 0; timer_mode = 1;
        load_segment_to_isr();
        TIMSK |= (1 << OCIE1A);
    }
    while (is_moving);
    q_head = q_tail = 0;  // FIX: lu�n reset c? 2 sau khi xong, k? c? q_tail==0
}
void jog_axis_deg(uint8_t axis, float delta_deg) {
    if (axis < 1 || axis > 3) {
        uart_puts("ERR|BAD_AXIS\n");
        return;
    }

    if (is_moving || timer_mode != 0) {
        uart_puts("ERR|BUSY\n");
        return;
    }

    float t1 = (float)motors[0].current_pos / STEPS_PER_DEGREE;
    float t2 = (float)motors[1].current_pos / STEPS_PER_DEGREE;
    float t3 = (float)motors[2].current_pos / STEPS_PER_DEGREE;

    if (axis == 1) {
        t1 += delta_deg;
    } else if (axis == 2) {
        t2 += delta_deg;
    } else {
        t3 += delta_deg;
    }

    q_head = 0;
    q_tail = 0;
    last_seg_delay = 0.0f;

    enqueue_motion(t1, t2, t3, 500.0f);
    wait_for_motion_finish();

    uart_puts("STATUS|JOG_DONE\n");
    uart_puts("R\n");
}
void run_homing() {
	uart_puts("STATUS|HOMING_START\n");
    MOTOR_PORT |= (1 << PA3) | (1 << PA5) | (1 << PA7);
    homing_backoff_count = 0;
    last_seg_delay = 0.0f; // Reset tr??c khi homing
    timer_mode = 2; OCR1A = 1200; TIMSK |= (1 << OCIE1A);
    while (timer_mode != 0);
    for (int i = 0; i < 3; i++) motors[i].current_pos = (long)(HOMING_ANGLE_DEG * STEPS_PER_DEGREE);
	uart_puts("STATUS|HOMING_DONE\n");
}

void process_s_command(char *cmd) {
    char command_id[16] = "";
    uint8_t command_error = 0;
    uint8_t servo_release_pending = 0;

    queue_full_flag = 0;

    if (uart_overflow_flag) {
        uart_puts("ERR|UART_OVERFLOW\n");
        uart_overflow_flag = 0;
        return;
    }


    char *cursor = cmd;
    char *token = next_token(&cursor); // S
    token = next_token(&cursor);

    while (token != NULL) {
        token = trim_token(token);

        if (token[0] == '\0') {
            token = next_token(&cursor);
            continue;
        }

        if (strncmp(token, "ID", 2) == 0) {
            strncpy(command_id, &token[2], sizeof(command_id) - 1);
            command_id[sizeof(command_id) - 1] = '\0';
            token = next_token(&cursor);
        }
        else if (token[0] == 'E') {
            if (servo_release_pending) {
                delay_ms_safe(SERVO_RELEASE_MIN_MS);
                release_servo_signal();
                servo_release_pending = 0;
            }
            wait_for_motion_finish();
            token = next_token(&cursor);
        }
        else if (token[0] == 'G') {
            wait_for_motion_finish();
            set_servo_angle_fine(atof(&token[1]));
            servo_release_pending = 1;
            token = next_token(&cursor);
        }
        else if (token[0] == 'D') {
            wait_for_motion_finish();
            uint32_t delay_ms = (uint32_t)atoi(&token[1]);
            delay_ms_safe(delay_ms);
            if (servo_release_pending) {
                if (delay_ms < SERVO_RELEASE_MIN_MS) {
                    delay_ms_safe(SERVO_RELEASE_MIN_MS - delay_ms);
                }
                release_servo_signal();
                servo_release_pending = 0;
            }
            token = next_token(&cursor);
        }
        else if (token[0] == 'V') {
            if (servo_release_pending) {
                delay_ms_safe(SERVO_RELEASE_MIN_MS);
                release_servo_signal();
                servo_release_pending = 0;
            }
            wait_for_motion_finish();
            if (token[1] == '1') RELAY_PORT_V |= (1 << PC2);
            else                 RELAY_PORT_V &= ~(1 << PC2);
            token = next_token(&cursor);
        }
        else if (strchr(token, ',')) {
            if (servo_release_pending) {
                delay_ms_safe(SERVO_RELEASE_MIN_MS);
                release_servo_signal();
                servo_release_pending = 0;
            }
            char *p1 = strchr(token, ',');
            char *p2 = p1 ? strchr(p1 + 1, ',') : NULL;

            if (!p1 || !p2) {
                uart_puts("ERR|BAD_WAYPOINT\n");
                command_error = 1;
                break;
            }

            float t1 = atof(token);
            float t2 = atof(p1 + 1);
            float t3 = atof(p2 + 1);

            token = next_token(&cursor);
            if (!token || token[0] != 'T') {
                uart_puts("ERR|MISSING_T\n");
                command_error = 1;
                break;
            }

            enqueue_motion(t1, t2, t3, atof(&token[1]));
            if (queue_full_flag) {
                uart_puts("ERR|QUEUE_FULL\n");
                command_error = 1;
                break;
            }

            token = next_token(&cursor);
        }
        else {
            uart_puts("ERR|BAD_TOKEN|");
            uart_puts(token);
            uart_puts("\n");
            command_error = 1;
            break;
        }
    }

    if (servo_release_pending) {
        delay_ms_safe(SERVO_RELEASE_MIN_MS);
        release_servo_signal();
    }

    wait_for_motion_finish();

    if (!command_error) {
        if (command_id[0] != '\0') {
            uart_puts("OK|ID");
            uart_puts(command_id);
            uart_puts("|DONE\n");
        }
        uart_puts("R\n");
    }
}

void init() {
    MOTOR_DDR = 0xFC; DDRC |= (1 << PC2);
    DDRB &= ~((1<<PB0)|(1<<PB1)|(1<<PB4));
    PORTB &= ~((1 << PB0) | (1 << PB1) | (1 << PB4));
    DDRD &= ~(1 << PD2);
    PORTD &= ~(1 << PD2);
    MCUCR |= (1 << ISC01); MCUCR &= ~(1 << ISC00);
    GIFR  |= (1 << INTF0); GICR  |= (1 << INT0);
    timer1_init();
}

int main(void) {
    uart_init(MYUBRR); init();
    timer0_init_servo();
	//timer2_motor_hut_init();
    PORTC &= ~(1 << PC2); // M?c ??nh: van h?t
    sei();

    while (1) {
        if (command_ready) {
			// L?nh RESET sau emergency
			if (rx_buffer[0] == 'X') {
				emergency_flag = 0;
				uart_puts("STATUS|RESET_OK\n");
				command_ready = 0;  // FIX: ph?i reset tr??c khi ti?p t?c
				continue;
			}
			if (emergency_flag) {
				uart_puts("STATUS|BLOCKED_EMERGENCY\n");
				command_ready = 0;  // FIX: ph?i reset, n?u kh�ng loop m�i l?nh c?
				continue;
			}
            if (rx_buffer[0] == 'J') {
                uint8_t axis = rx_buffer[1] - '0';
                char sign = rx_buffer[2];
                float deg = atof((char*)&rx_buffer[3]);

                if (sign == '-') {
                    deg = -deg;
                }

                jog_axis_deg(axis, deg);

                command_ready = 0;
                continue;
            }
            if (rx_buffer[0] == 'H') {
                run_homing();
                uart_puts("R\n");
            }
            else if (rx_buffer[0] == 'S' && rx_buffer[1] == '|') {
                rx_busy = 1;
                process_s_command((char*)rx_buffer);
                rx_busy = 0;
                rx_index = 0;
                command_ready = 0;
                continue;

            }
            command_ready = 0;
        }
    }
}
