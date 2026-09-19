import { Input, type InputProps } from "antd";
import type React from "react";
import { type ChangeEvent, useEffect, useState } from "react";

interface PhoneInputProps extends Omit<InputProps, "onChange" | "value"> {
	value?: string;
	onChange?: (value: string) => void;
}

const formatPhoneNumber = (input: string) => {
	// Clean input to get only relevant digits
	let digits = "";
	if (input.startsWith("+998")) {
		// handle both +998 and +998- cases
		const start = input.startsWith("+998-") ? 5 : 4;
		digits = input.slice(start).replace(/\D/g, "");
	} else {
		digits = input.replace(/\D/g, "");
	}

	// Limit to 9 digits (Uzbekistan number length after prefix)
	digits = digits.slice(0, 9);

	let result = "+998-";

	if (digits.length > 0) {
		result += digits.slice(0, 2);
	}
	if (digits.length > 2) {
		result += `-${digits.slice(2, 5)}`;
	}
	if (digits.length > 5) {
		result += `-${digits.slice(5, 7)}`;
	}
	if (digits.length > 7) {
		result += `-${digits.slice(7, 9)}`;
	}

	return result;
};

const getCleanValue = (formattedValue: string) => {
	const digits = formattedValue.slice(5).replace(/\D/g, "");
	return `+998${digits}`;
};

export const PhoneInput: React.FC<PhoneInputProps> = ({ value, onChange, ...props }) => {
	const [displayValue, setDisplayValue] = useState("+998-");

	useEffect(() => {
		if (value) {
			const formatted = formatPhoneNumber(value);
			if (formatted !== displayValue) {
				setDisplayValue(formatted);
			}
		} else {
			setDisplayValue("+998-");
		}
	}, [value, displayValue]);

	const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
		const input = e.target.value;

		const formatted = formatPhoneNumber(input);
		setDisplayValue(formatted);
		onChange?.(getCleanValue(formatted));
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		const selectionStart = (e.target as HTMLInputElement).selectionStart;
		const selectionEnd = (e.target as HTMLInputElement).selectionEnd;

		// Prevent deleting the prefix
		if (
			e.key === "Backspace" &&
			selectionStart !== null &&
			selectionEnd !== null &&
			selectionStart <= 5 &&
			selectionEnd <= 5
		) {
			e.preventDefault();
		}
	};

	return (
		<Input
			{...props}
			value={displayValue}
			onChange={handleChange}
			onKeyDown={handleKeyDown}
			placeholder="+998-XX-XXX-XX-XX"
		/>
	);
};
