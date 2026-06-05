/*
 * udmt.c - C?i ti?n PID: Ch?ng v?t l? (Overshoot) v� Derivative Kick
 * FIX: Bumpless Transfer c� d?u chi?u quay + Kp/Ki/Kd/Vset=0 l�c boot
 */ 
#define F_CPU 8000000UL

#include <avr/io.h>
#include <util/delay.h>
#include <avr/interrupt.h>
#include <stdbool.h>
#include <util/atomic.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdio.h>

/* ============================================================ 
    ??NH NGH?A & C?U H�NH
   ============================================================ */
#define SPEED_SAMPLE_SIZE    10
#define SPEED_EMA_ALPHA      0.2f

#define POWER_SAMPLE_SIZE    3
#define POWER_EMA_ALPHA      0.8f  

#define SHUNT_OHM          0.1f   
#define CURRENT_OFFSET_MA 0.8f   
#define L298N_VDROP        1.5f 
#define VBUS               13.3f   

#define PWM_TOP            4095
#define PWM_50_PERCENT     2048
#define CHUKY              0.024f  
#define DEGREE_SCALER      (360.0f / (44.0f * 11.0f))

#define BTN_HOLD_DELAY    250
#define BTN_REPEAT_RATE   10

#define MAX_ANGLE_SPEED    850.0f
#define PWM_SCALE          ((float)PWM_TOP / MAX_ANGLE_SPEED)
#define FEEDFORWARD_KS_PWM 260.0f
#define FEEDFORWARD_KV_PWM 2.9f

// Gi?i h?n t�ch ph�n ?? tr�nh v?t l? ? t?c ?? th?p
#define I_TERM_LIMIT       850.0f
#define DIR_CHANGE_SPEED_TH     100.0f   // t?c ?? coi nh? g?n d?ng, ??n v? ??/s
#define DIR_CHANGE_STABLE_COUNT 5       // c?n g?n 0 li�n ti?p 5 chu k?
#define DIR_CHANGE_TIMEOUT_CNT  125     // timeout: 125 * 24ms ? 3 gi�y



// PID gi?m
#define VSET_RAMP_DOWN_LOW_STEP    2.0f    // t?c th?c 0-300
#define VSET_RAMP_DOWN_MID_STEP   5.0f    // t?c th?c 300-500
#define VSET_RAMP_DOWN_HIGH_STEP  40.0f    // t?c th?c >500

#define VSET_RAMP_DOWN_FOLLOW_GAP_HIGH   250.0f
#define VSET_RAMP_DOWN_FOLLOW_GAP_MID    150.0f
#define VSET_RAMP_DOWN_FOLLOW_GAP_LOW     70.0f

//PID tang
#define VSET_RAMP_UP_LOW_MIN_STEP      1.0f
#define VSET_RAMP_UP_LOW_MAX_STEP     10.0f
#define VSET_RAMP_UP_LOW_GAP_MAX     250.0f

#define VSET_RAMP_UP_MID_MIN_STEP      5.0f
#define VSET_RAMP_UP_MID_MAX_STEP     15.0f
#define VSET_RAMP_UP_MID_GAP_MAX     250.0f

#define VSET_RAMP_UP_HIGH_STEP        70.0f
/* ============================================================ 
    BI?N TO�N C?C
   ============================================================ */
volatile long encoder_count = 0, last_count = 0;
volatile uint8_t mode = 1;          
volatile uint8_t stop_flag = 1;     
volatile uint8_t dir_manual = 0;   
volatile uint8_t dir_next = 0;     
volatile uint16_t pwm_value = PWM_50_PERCENT;

volatile bool pid_ready_flag = false;
volatile bool tx_req = false;
volatile bool save_req = false;
// �?o chi?u an to�n 
volatile uint8_t dir_change_pending = 0;
volatile uint8_t dir_target = 1;

uint8_t dir_zero_count = 0;
uint16_t dir_wait_count = 0;
uint16_t pwm_before_dir_change = PWM_50_PERCENT;
/* L?c d? li?u */
float arr_speed[SPEED_SAMPLE_SIZE];
float arr_current[POWER_SAMPLE_SIZE];
float arr_voltage[POWER_SAMPLE_SIZE];
uint8_t idx_speed = 0, idx_current = 0, idx_voltage = 0;
float speed_ema = 0, current_ema = 0, voltage_ema = 0;
float V_set_ramp = 0.0f;
/* PID CONTROL
 * [FIX] Kp, Ki, Kd, V_set m?c ??nh = 0 khi kh?i ??ng.
 * Kh�ng load EEPROM ? r�t ?i?n l� m?t h?t.
 * Nh?n STOP th� l?u v�o RAM n?i b? (bi?n b�n d??i), kh�ng ghi EEPROM.
 */
volatile float Kp = 0.8f, Ki = 2.0f, Kd = 0.1f;
volatile long  V_set = 320;
float Integral = 0, Last_Error = 0, last_speed_pv = 0;

/* L?u t?m khi nh?n STOP (RAM only, kh�ng EEPROM) */
static float  saved_Kp = 0.0f, saved_Ki = 0.0f, saved_Kd = 0.0f;
static long   saved_Vset = 0;
static uint8_t saved_mode = 0;
static uint16_t saved_pwm = PWM_50_PERCENT;
static uint8_t  saved_dir = 1;

/* UART & RX */
char rx_buf[64];
uint8_t rx_idx = 0;
volatile bool data_ready = false;

volatile uint8_t last_btn_state = 0xFF; 
uint16_t hold_up_timer = 0, hold_down_timer = 0;
float speed_signed_filtered = 0;

/* ============================================================ 
    H�M H? TR? NGO?I VI
   ============================================================ */
void uart_init() {
    UCSRA = (1 << U2X);
    UBRRH = (uint8_t)((((F_CPU / (38400UL * 8UL))) - 1) >> 8);
    UBRRL = (uint8_t)(((F_CPU / (38400UL * 8UL))) - 1);
    UCSRB = (1 << RXCIE) | (1 << RXEN) | (1 << TXEN);
    UCSRC = (1 << URSEL) | (1 << UCSZ1) | (1 << UCSZ0);
}
void uart_puts(const char* s) { while (*s) { while (!(UCSRA & (1 << UDRE))); UDR = *s++; } }

void pwm_init() {
    DDRD |= (1 << PD5);
    TCCR1A = (1 << COM1A1) | (1 << WGM11);
    TCCR1B = (1 << WGM13) | (1 << WGM12) | (1 << CS10);
    ICR1 = PWM_TOP; OCR1A = 0;
}

void timer2_init() { TCCR2 = (1 << WGM21) | (1 << CS22) | (1 << CS21) | (1 << CS20); OCR2 = 187; TIMSK |= (1 << OCIE2); }
void timer0_init() { TCCR0 = (1 << WGM01) | (1 << CS01) | (1 << CS00); OCR0 = 249; TIMSK |= (1 << OCIE0); }

void i2c_init() { TWBR = ((F_CPU/100000UL)-16)/2; TWCR = (1<<TWEN); }
void i2c_start() { TWCR = (1<<TWINT)|(1<<TWSTA)|(1<<TWEN); while(!(TWCR & (1<<TWINT))); }
void i2c_stop() { TWCR = (1<<TWINT)|(1<<TWSTO)|(1<<TWEN); while(TWCR & (1<<TWSTO)); }
void i2c_write(uint8_t d) { TWDR = d; TWCR = (1<<TWINT)|(1<<TWEN); while(!(TWCR & (1<<TWINT))); }
uint8_t i2c_read(uint8_t ack) { TWCR = (1<<TWINT)|(1<<TWEN)|(ack?(1<<TWEA):0); while(!(TWCR & (1<<TWINT))); return TWDR; }

void ina219_init() { i2c_start(); i2c_write(0x40 << 1); i2c_write(0x00); i2c_write(0x21); i2c_write(0xE7); i2c_stop(); }
int16_t ina219_read_raw() {
    i2c_start(); i2c_write(0x40 << 1); i2c_write(0x01); i2c_start(); i2c_write((0x40 << 1) | 1);
    uint8_t h = i2c_read(1); uint8_t l = i2c_read(0); i2c_stop();
    return (int16_t)((h << 8) | l);
}

void apply_direction(uint8_t d) {
    if (d == 1) { PORTD &= ~(1 << PD4); _delay_us(2); PORTD |= (1 << PD6); }
    else { PORTD &= ~(1 << PD6); _delay_us(2); PORTD |= (1 << PD4); }
}
void motor_coast_stop() {
	OCR1A = 0;
	PORTD &= ~((1 << PD4) | (1 << PD6));
}

void request_direction_change(uint8_t new_dir) {
	new_dir = new_dir ? 1 : 0;

	// N?u ?ang c�ng chi?u r?i th� kh�ng c?n x? l�
	if (new_dir == dir_manual && !dir_change_pending) {
		dir_next = new_dir;
		return;
	}

	dir_target = new_dir;
	dir_next = new_dir;

	// L?u l?i PWM manual ?? sau khi ??o chi?u c� th? ph?c h?i
	pwm_before_dir_change = pwm_value;

	// B?t ??u qu� tr�nh ch? ??ng c? g?n d?ng
	dir_change_pending = 1;
	dir_zero_count = 0;
	dir_wait_count = 0;

	// T?t ?i?u khi?n ngay
	motor_coast_stop();

	// Reset PID ?? tr�nh t�ch ph�n c? k�o ??ng c? gi?t
	Integral = 0;
	Last_Error = 0;
	last_speed_pv = speed_signed_filtered;
	V_set_ramp = fabsf(speed_signed_filtered);
}
float apply_filter_custom(float new_val, float* arr, uint8_t* idx, float* ema,
uint8_t sample_size, float alpha) {
	arr[*idx] = new_val;
	*idx = (*idx + 1) % sample_size;

	float sum = 0;
	for (uint8_t i = 0; i < sample_size; i++) {
		sum += arr[i];
	}

	float avg = sum / (float)sample_size;

	if (*ema == 0) {
		*ema = avg;
		} else {
		*ema = (alpha * avg) + (1.0f - alpha) * (*ema);
	}

	return *ema;
}

/* [FIX] L?u v�o RAM n?i b? (kh�ng EEPROM) � r�t ?i?n l� m?t */
void ram_save_state() {
    saved_Kp   = Kp;
    saved_Ki   = Ki;
    saved_Kd   = Kd;
    saved_Vset = V_set;
    saved_mode = mode;
    saved_pwm  = pwm_value;
    saved_dir  = dir_manual;
}

/* ============================================================ 
    NG?T
   ============================================================ */
ISR(TIMER2_COMP_vect) { pid_ready_flag = true; }
ISR(INT0_vect) { if (PIND & (1 << PD3)) encoder_count++; else encoder_count--; }
ISR(USART_RXC_vect) {
    char c = UDR;
    if (c == ';') { rx_buf[rx_idx] = '\0'; data_ready = true; rx_idx = 0; }
    else if (rx_idx < 63) rx_buf[rx_idx++] = c;
}

ISR(TIMER0_COMP_vect) {
    uint8_t current_btns = (PINA & 0x03) | ((PINB & 0x07) << 2);

    if (!(current_btns & (1 << 2)) && (last_btn_state & (1 << 2))) stop_flag = 0;

    /* [FIX] Nh?n STOP ? l?u RAM (kh�ng EEPROM) */
    if (!(current_btns & (1 << 3)) && (last_btn_state & (1 << 3))) {
        stop_flag = 1;
        save_req = true;   /* main loop s? g?i ram_save_state() */
    }

    if (mode == 0) {
        if (!(current_btns & (1 << 1))) {
            if (last_btn_state & (1 << 1)) { if (pwm_value < PWM_TOP) pwm_value++; hold_up_timer = 0; }
            else { hold_up_timer++; if (hold_up_timer >= BTN_HOLD_DELAY && hold_up_timer % BTN_REPEAT_RATE == 0) {
                if (pwm_value <= (PWM_TOP - 40)) pwm_value += 40; else pwm_value = PWM_TOP; } }
        }
        if (!(current_btns & (1 << 0))) {
            if (last_btn_state & (1 << 0)) { if (pwm_value > 0) pwm_value--; hold_down_timer = 0; }
            else { hold_down_timer++; if (hold_down_timer >= BTN_HOLD_DELAY && hold_down_timer % BTN_REPEAT_RATE == 0) {
                if (pwm_value >= 40) pwm_value -= 40; else pwm_value = 0; } }
        }
        if (!(current_btns & (1 << 4)) && (last_btn_state & (1 << 4))) {
	        request_direction_change(dir_manual ^ 1);
        }
    }

    last_btn_state = current_btns;
}

static void parse_config_frame(char* buf) {
    char* token = strtok(buf, ",");
    while (token != NULL) {
        if (token[0] != '\0' && token[1] == ':') {
            char key = token[0]; char* val = token + 2;
            switch (key) {
                case 'P': Kp = atof(val); break;
                case 'I': Ki = atof(val); break;
                case 'D': Kd = atof(val); break;
                case 'V': V_set = atol(val); break;
                case 'R':
                {
	                uint8_t r_val = (uint8_t)atoi(val);
	                r_val = r_val ? 1 : 0;

	                if (mode == 1) {
		                if (r_val != dir_manual) {
			                request_direction_change(r_val);
			                } else {
			                dir_next = r_val;
		                }
		                } else {
		                dir_next = r_val;
	                }

	                break;
                }
            }
        }
        token = strtok(NULL, ",");
    }
}
float lerp_float(float a, float b, float t) {
	if (t < 0.0f) t = 0.0f;
	if (t > 1.0f) t = 1.0f;
	return a + (b - a) * t;
}

float get_vset_ramp_up_step(float current, float target) {
	float target_abs = fabsf(target);
	float gap = fabsf(target - current);

	if (target_abs <= 300.0f) {
		float ratio = gap / VSET_RAMP_UP_LOW_GAP_MAX;
		return lerp_float(VSET_RAMP_UP_LOW_MIN_STEP,
		VSET_RAMP_UP_LOW_MAX_STEP,
		ratio);
	}
	else if (target_abs <= 500.0f) {
		float ratio = gap / VSET_RAMP_UP_MID_GAP_MAX;
		return lerp_float(VSET_RAMP_UP_MID_MIN_STEP,
		VSET_RAMP_UP_MID_MAX_STEP,
		ratio);
	}
	else {
		return VSET_RAMP_UP_HIGH_STEP;
	}
}


float get_vset_ramp_down_step(float actual_speed) {
	float ref = fabsf(actual_speed);

	if (ref <= 300.0f) {
		return VSET_RAMP_DOWN_LOW_STEP;
		} else if (ref <= 500.0f) {
		return VSET_RAMP_DOWN_MID_STEP;
		} else {
		return VSET_RAMP_DOWN_HIGH_STEP;
	}
}

float get_vset_down_follow_gap(float actual_speed) {
	float ref = fabsf(actual_speed);

	if (ref <= 300.0f) {
		return VSET_RAMP_DOWN_FOLLOW_GAP_LOW;
		} else if (ref <= 500.0f) {
		return VSET_RAMP_DOWN_FOLLOW_GAP_MID;
		} else {
		return VSET_RAMP_DOWN_FOLLOW_GAP_HIGH;
	}
}

float calc_feedforward_pwm(float speed_abs) {
	if (speed_abs < 1.0f) return 0.0f;

	float pwm = FEEDFORWARD_KS_PWM + (FEEDFORWARD_KV_PWM * speed_abs);
	if (pwm > (float)PWM_TOP) pwm = (float)PWM_TOP;
	if (pwm < 0.0f) pwm = 0.0f;
	return pwm;
}

float update_vset_ramp(float target, float actual_speed) {
	float step;

	if (V_set_ramp < target) {
		// T?NG: gi? logic t?ng nh? hi?n t?i
		step = get_vset_ramp_up_step(V_set_ramp, target);

		V_set_ramp += step;
		if (V_set_ramp > target) {
			V_set_ramp = target;
		}
	}
	else if (V_set_ramp > target) {
		// GI?M: gi?m theo t?c ?? th?t, nh?ng kh�ng cho ramp t?t qu� xa so v?i speed
		step = get_vset_ramp_down_step(actual_speed);

		float actual_abs = fabsf(actual_speed);
		float gap = get_vset_down_follow_gap(actual_speed);

		// Ramp th?p nh?t ???c ph�p ? chu k? n�y
		// V� d? actual=700, gap=180 => ramp ch?a ???c th?p h?n 520
		float min_ramp_allowed = actual_abs - gap;

		if (min_ramp_allowed < target) {
			min_ramp_allowed = target;
		}

		V_set_ramp -= step;

		if (V_set_ramp < min_ramp_allowed) {
			V_set_ramp = min_ramp_allowed;
		}

		if (V_set_ramp < target) {
			V_set_ramp = target;
		}
	}

	return V_set_ramp;
}

void handle_web_command(char* cmd) {
	if (strcmp(cmd, "CMD:START") == 0) {	
		if (!dir_change_pending) {
			stop_flag = 0;
			uart_puts("OK:START\n");
			} else {
			uart_puts("ERR:DIR_PENDING\n");
		}
	}
	else if (strcmp(cmd, "CMD:DIR") == 0) {
		if (mode == 0) {
			request_direction_change(dir_manual ^ 1);
			uart_puts("OK:DIR\n");
			} 
	}
	else if (strcmp(cmd, "CMD:STOP") == 0) {
		stop_flag = 1;
		save_req = true;
		uart_puts("OK:STOP\n");
	}
	else if (strcmp(cmd, "CMD:UP") == 0) {
		if (mode == 0) {
			if (pwm_value <= (PWM_TOP - 40)) {
				pwm_value += 40;
				} else {
				pwm_value = PWM_TOP;
			}
			uart_puts("OK:UP\n");
			} else {
			uart_puts("ERR:UP_AUTO\n");
		}
	}
	else if (strcmp(cmd, "CMD:DOWN") == 0) {
		if (mode == 0) {
			if (pwm_value >= 40) {
				pwm_value -= 40;
				} else {
				pwm_value = 0;
			}
			uart_puts("OK:DOWN\n");
			} else {
			uart_puts("ERR:DOWN_AUTO\n");
		}
	}
}
/* ============================================================ 
    MAIN LOOP
   ============================================================ */
int main() {
    DDRD |= (1 << PD4) | (1 << PD5) | (1 << PD6); 
    DDRA &= ~0x03; DDRB &= ~0x07; DDRD &= ~((1 << PD2) | (1 << PD3));
    uart_init(); i2c_init(); ina219_init(); pwm_init(); timer0_init(); timer2_init();
    MCUCR = (1 << ISC01) | (1 << ISC00); GICR |= (1 << INT0); sei();

    /* [FIX] KH�NG load EEPROM � Kp/Ki/Kd/V_set=0 m?i l?n c?p ngu?n */

    while(1) {
        if (pid_ready_flag) {
            pid_ready_flag = false;
            long cnt; ATOMIC_BLOCK(ATOMIC_RESTORESTATE) { cnt = encoder_count; }
            float speed_raw_signed = ((float)(cnt - last_count) * DEGREE_SCALER) / CHUKY;
            last_count = cnt;
            speed_signed_filtered = apply_filter_custom(
            speed_raw_signed,
            arr_speed,
            &idx_speed,
            &speed_ema,
            SPEED_SAMPLE_SIZE,
            SPEED_EMA_ALPHA
            );
            
            int16_t raw_shunt = ina219_read_raw();
            float cur_ma = ((float)raw_shunt * 0.01f / SHUNT_OHM) - CURRENT_OFFSET_MA;
            current_ema = apply_filter_custom(
            (cur_ma < 0 ? 0 : cur_ma),
            arr_current,
            &idx_current,
            &current_ema,
            POWER_SAMPLE_SIZE,
            POWER_EMA_ALPHA
            );

            float duty = (float)OCR1A / PWM_TOP;
            float u_val = (VBUS * duty) - L298N_VDROP;

            if (OCR1A == 0) {
	            u_val = 0.0f;
            }

            if (u_val < 0.0f) {
	            u_val = 0.0f;
            }
            voltage_ema = apply_filter_custom(
            (u_val < 0 ? 0 : u_val),
            arr_voltage,
            &idx_voltage,
            &voltage_ema,
            POWER_SAMPLE_SIZE,
            POWER_EMA_ALPHA
            );
			// ============================================================
			// X? L� ??O CHI?U AN TO�N
			// Khi ?ang pending: t?t PWM, ch? t?c ?? g?n 0 r?i m?i ??i chi?u
			// ============================================================
			if (dir_change_pending) {
				motor_coast_stop();

				if (fabsf(speed_signed_filtered) <= DIR_CHANGE_SPEED_TH) {
					dir_zero_count++;
					} else {
					dir_zero_count = 0;
				}

				dir_wait_count++;

				if (dir_zero_count >= DIR_CHANGE_STABLE_COUNT || dir_wait_count >= DIR_CHANGE_TIMEOUT_CNT) {
					dir_manual = dir_target;
					dir_next = dir_target;

					apply_direction(dir_manual);

					Integral = 0;
					Last_Error = 0;
					last_speed_pv = speed_signed_filtered;

					dir_change_pending = 0;
					dir_zero_count = 0;
					dir_wait_count = 0;

					// N?u ?ang Manual th� kh�i ph?c PWM c?
					// N?u ?ang Auto th� PID s? t? t?ng PWM l?i ? c�c chu k? sau
					if (mode == 0 && !stop_flag) {
						pwm_value = pwm_before_dir_change;
						OCR1A = pwm_value;
					}
				}

				tx_req = true;
				continue;
			}
            if (stop_flag) {
                OCR1A = 0; Integral = 0; Last_Error = 0;V_set_ramp = 0.0f;
                PORTD &= ~((1 << PD4) | (1 << PD6));
            } else {
                if (mode == 0) {
                    apply_direction(dir_manual);
                    OCR1A = pwm_value;
                } else {
                    /* ==========================================
                       THU?T TO�N PID C?I TI?N
                       ========================================== */
                    float V_set_abs_ramp = update_vset_ramp((float)V_set, speed_signed_filtered);
                    float V_set_PID = (dir_manual == 1) ? V_set_abs_ramp : -V_set_abs_ramp;
                    float Error = V_set_PID - speed_signed_filtered;

                    // Derivative theo t?c ?? th?c ?? tr�nh derivative kick
                    float Derivative = -(speed_signed_filtered - last_speed_pv) / CHUKY;
                    last_speed_pv = speed_signed_filtered;

                    // T�ch ph�n
                    Integral += Error * CHUKY;

                    // Gi?i h?n Integral ??ng theo Ki, xem m?c 3 b�n d??i
                    float dynamic_I_limit = 0.0f;
                    if (Ki > 0.01f) {
	                    dynamic_I_limit = I_TERM_LIMIT / Ki;
	                    } else {
	                    dynamic_I_limit = 0.0f;
                    }

                    if (Integral > dynamic_I_limit) Integral = dynamic_I_limit;
                    else if (Integral < -dynamic_I_limit) Integral = -dynamic_I_limit;

                    float u_t = (Kp * Error) + (Ki * Integral) + (Kd * Derivative);

                    // Auto chi cho chay theo chieu da chon.
                    // Feedforward tao PWM nen theo V_set, PID chi bu sai so con lai.
                    apply_direction(dir_manual);

                    float feedforward_pwm = calc_feedforward_pwm(V_set_abs_ramp);
                    float pid_pwm_correction = (dir_manual == 1)
                        ? (u_t * PWM_SCALE)
                        : (-u_t * PWM_SCALE);
                    float scaled_u_t = feedforward_pwm + pid_pwm_correction;

                    if (scaled_u_t > (float)PWM_TOP) {
	                    OCR1A = PWM_TOP;

	                    // Anti-windup khi bao hoa tren.
	                    if (pid_pwm_correction > 0.0f) {
		                    Integral -= Error * CHUKY;
	                    }
                    } else if (scaled_u_t < 0.0f) {
	                    OCR1A = 0;
	                    if (pid_pwm_correction < 0.0f) {
		                    Integral -= Error * CHUKY;
	                    }
                    } else {
	                    OCR1A = (uint16_t)scaled_u_t;
                    }

                    Last_Error = Error;
                }
            }
            tx_req = true;
        }

        /* X? L� GIAO TI?P V� CHUY?N CH? ?? */
        if (data_ready) {
            char local_buf[64];
            ATOMIC_BLOCK(ATOMIC_RESTORESTATE) { strncpy(local_buf, rx_buf, 63); local_buf[63] = '\0'; data_ready = false; }
			if (strncmp(local_buf, "CMD:", 4) == 0) {
				handle_web_command(local_buf);
			}
            else if (local_buf[0] == 'M' && local_buf[1] == ':') {
                uint8_t new_mode = (uint8_t)atoi(&local_buf[2]);
                if (new_mode == 1 && mode == 0) {
                    if (dir_next != dir_manual) {
	                    request_direction_change(dir_next);
	                    } else {
	                    apply_direction(dir_manual);
                    }

                    /* ==========================================
                       [FIX] Bumpless Transfer c� d?u chi?u quay
                       
                       V?n ?? c?:
                         Integral = OCR1A / Ki  ? lu�n d??ng
                         ? manual ngh?ch chuy?n auto: u_t > 0 ? thu?n ? GI?T
                       
                       S?a:
                         OCR1A ???c k� hi?u theo chi?u th?c t?
                         dir=1 (thu?n) ? ocr_signed > 0 ? Integral > 0 ? u_t > 0 ? thu?n ?
                         dir=0 (ngh?ch) ? ocr_signed < 0 ? Integral < 0 ? u_t < 0 ? ngh?ch ?
                       ========================================== */
                    float ocr_signed = (dir_manual == 1) ? (float)OCR1A : -(float)OCR1A;
                    if (Ki > 0.01f) Integral = (ocr_signed / PWM_SCALE) / Ki;
                    else Integral = 0;

                    last_speed_pv = speed_signed_filtered;
					V_set_ramp = fabsf(speed_signed_filtered);
                }
                else if (new_mode == 0 && mode == 1) {
                    pwm_value = OCR1A;
					V_set_ramp = fabsf(speed_signed_filtered);
                    if (PIND & (1 << PD6)) dir_manual = 1;
                    else if (PIND & (1 << PD4)) dir_manual = 0;
                }
                mode = new_mode;
                uart_puts("OK:M\n");
            } else {
                parse_config_frame(local_buf);
                uart_puts("OK:C\n");
            }
        }

        /* [FIX] Nh?n STOP ? l?u RAM (kh�ng EEPROM) */
        if (save_req) {
            save_req = false;
            ram_save_state();
        }

        if (tx_req) {
            tx_req = false;
            char msg[128], fs[10], fi[10], fv[10], fkp[8], fki[8], fkd[8];
            dtostrf(fabsf(speed_ema), 6, 2, fs); dtostrf(current_ema, 6, 2, fi);
            dtostrf(voltage_ema, 6, 2, fv); dtostrf(Kp, 4, 2, fkp);
            dtostrf(Ki, 4, 2, fki); dtostrf(Kd, 4, 2, fkd);
            sprintf(msg, "A:%s,S:%ld,I:%s,V:%s,M:%d,P:%s,L:%s,D:%s,R:%d\n",
                    fs, V_set, fi, fv, mode, fkp, fki, fkd, dir_manual);
            uart_puts(msg);
        }
    }
}
