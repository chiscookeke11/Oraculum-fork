import {
  IsUUID,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { PlanType } from '../enums/plan-type.enum';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const DATE_ONLY_PATTERN = /^(\\d{4})-(\\d{2})-(\\d{2})$/;
const ISO_INSTANT_PATTERN =
  /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,3}))?(Z|([+-])(\\d{2}):(\\d{2}))$/;

/**
 * Accept calendar dates (YYYY-MM-DD) and unambiguous ISO instants with an
 * explicit UTC designator or numeric offset. Local date-times are rejected.
 */
export function isStrictBookingDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;

  const dateOnly = DATE_ONLY_PATTERN.exec(value);
  const instant = ISO_INSTANT_PATTERN.exec(value);
  const match = dateOnly ?? instant;
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31, leapYear ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31,
  ][month - 1];

  if (month < 1 || month > 12 || day < 1 || day > (daysInMonth ?? 0)) {
    return false;
  }
  if (dateOnly) return true;

  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return false;

  if (match[8] !== 'Z') {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return false;
    }
  }

  return Number.isFinite(Date.parse(value));
}

@ValidatorConstraint({ name: 'isStrictBookingDate', async: false })
class IsStrictBookingDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isStrictBookingDate(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be YYYY-MM-DD or an ISO timestamp with Z/a numeric UTC offset`;
  }
}

@ValidatorConstraint({ name: 'isEndAfterStart', async: false })
class IsEndAfterStartConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const { startDate } = args.object as { startDate?: unknown };
    return (
      isStrictBookingDate(startDate) &&
      isStrictBookingDate(value) &&
      Date.parse(value) > Date.parse(startDate)
    );
  }

  defaultMessage(): string {
    return 'endDate must be after startDate';
  }
}

export class CreateBookingDto {
  @ApiProperty()
  @IsUUID()
  workspaceId: string;

  @ApiProperty({ enum: PlanType })
  @IsEnum(PlanType)
  planType: PlanType;

  @ApiProperty({ example: '2026-04-01', description: 'YYYY-MM-DD or ISO timestamp with an explicit timezone' })
  @Validate(IsStrictBookingDateConstraint)
  startDate: string;

  @ApiProperty({ example: '2026-04-30', description: 'YYYY-MM-DD or ISO timestamp with an explicit timezone' })
  @Validate(IsStrictBookingDateConstraint)
  @Validate(IsEndAfterStartConstraint)
  endDate: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  seatCount: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
