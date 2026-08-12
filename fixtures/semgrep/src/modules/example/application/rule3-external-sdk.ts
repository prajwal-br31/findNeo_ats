// RULE 3 (ER-011): SDK imported outside platform/
import PgBoss from 'pg-boss';
import nodemailer from 'nodemailer';
export const bad = [PgBoss, nodemailer];
