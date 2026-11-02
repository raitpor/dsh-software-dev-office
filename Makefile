check:
	python3 docs/check.py

probe:
	python3 probe/run.py

all: check probe

.PHONY: check probe all
