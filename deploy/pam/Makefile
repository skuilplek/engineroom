CC ?= gcc
CFLAGS ?= -O2 -Wall -Wextra -fstack-protector-strong -D_FORTIFY_SOURCE=2
LDFLAGS ?= -Wl,-z,relro,-z,now

.PHONY: all clean

all: engineroom-pam-auth engineroom-peercred

engineroom-pam-auth: engineroom-pam-auth.c
	$(CC) $(CFLAGS) -o $@ $< -lpam $(LDFLAGS)

engineroom-peercred: engineroom-peercred.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

clean:
	rm -f engineroom-pam-auth engineroom-peercred
